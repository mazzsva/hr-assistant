import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { pool } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { ingestAll } from "../src/ingest.ts";
import { retrieve, type Passage } from "../src/retrieve.ts";
import { activeEmbeddingModel } from "../src/embeddings.ts";
import { chunkMarkdown } from "../src/chunk.ts";
import {
  anthropicClient,
  ask,
  countEmployees,
  type AgentResult,
} from "../src/agent.ts";
import { config } from "../src/config.ts";

export interface Case {
  id: string;
  question: string;
  expectedSource: string | null;
  expectedSection: string | null;
  headcountQuery?: Record<string, string>;
  rubric: string;
  shouldEscalate: boolean;
}

interface Score {
  passed: number;
  total: number;
}

// Thresholds are the gate: CI fails when a metric drops below its floor.
const RETRIEVAL_FLOOR = 0.85;
const ANSWER_FLOOR = 0.8;
const ESCALATION_FLOOR = 1.0;

const CITATION = /\[(\d+(?:,\s*\d+)*)\]/g;

const judgeSchema = {
  type: "object",
  properties: {
    reason: { type: "string" },
    passed: { type: "boolean" },
  },
  required: ["reason", "passed"],
  additionalProperties: false,
} as const;

async function main(): Promise<void> {
  const dataset = process.env.EVAL_DATASET || "dataset.json";
  const repeats = Number(process.env.EVAL_REPEATS || 1);
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`EVAL_REPEATS must be a positive integer, not ${process.env.EVAL_REPEATS}`);
  }
  const cases = JSON.parse(
    await readFile(new URL(dataset, import.meta.url), "utf8"),
  ) as Case[];
  console.log(`dataset: ${dataset}, ${cases.length} cases`);
  for (const testCase of cases) {
    if (Boolean(testCase.expectedSource) !== Boolean(testCase.expectedSection)) {
      throw new Error(
        `${testCase.id}: set expectedSource and expectedSection together in evals/${dataset}`,
      );
    }
  }
  const sections = new Map<string, string>();
  for (const testCase of cases) {
    if (!testCase.expectedSource) continue;
    const section = await sectionText(testCase);
    if (!section) {
      throw new Error(
        `${testCase.id}: ${testCase.expectedSource} has no section "${testCase.expectedSection}"`,
      );
    }
    sections.set(testCase.id, section);
  }

  await migrate();
  await ingestAll();
  console.log(`embedding model: ${activeEmbeddingModel()}\n`);

  const retrieval = await scoreRetrieval(cases);
  const answers = config.anthropicApiKey ? await scoreAnswers(cases, sections, repeats) : null;
  if (!answers) console.log("answers: skipped (ANTHROPIC_API_KEY not set)\n");
  await pool.end();

  const failures: string[] = [];
  if (rate(retrieval) < RETRIEVAL_FLOOR) {
    failures.push(
      `retrieval recall@${config.retrievalTopK} ${format(retrieval)} < ${RETRIEVAL_FLOOR.toFixed(2)}`,
    );
  }
  if (answers && rate(answers.accuracy) < ANSWER_FLOOR) {
    failures.push(`answer accuracy ${format(answers.accuracy)} < ${ANSWER_FLOOR.toFixed(2)}`);
  }
  if (answers && rate(answers.escalation) < ESCALATION_FLOOR) {
    failures.push(
      `escalation accuracy ${format(answers.escalation)} < ${ESCALATION_FLOOR.toFixed(2)}`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(answers ? "all thresholds met" : "retrieval threshold met, answers not scored");
}

async function scoreRetrieval(cases: Case[]): Promise<Score> {
  const ranks: number[] = [];

  console.log("retrieval");
  for (const testCase of cases) {
    if (!testCase.expectedSource) continue;

    // Scores the raw question, not the agent's own queries, so it runs without an API key.
    const passages = await retrieve(testCase.question);
    const rank = passages.findIndex((passage) => matchesSection(passage, testCase)) + 1;
    ranks.push(rank);

    const top = passages[0];
    const topHeading = top?.content.split("\n").find((line) => line.startsWith("##"));
    console.log(
      `  ${rank > 0 ? "pass" : "FAIL"}  ${testCase.id}  ` +
        `rank=${rank > 0 ? rank : "-"} ` +
        `top=${top?.source ?? "none"} "${topHeading ?? ""}" ` +
        `sim=${top?.similarity.toFixed(3) ?? "-"}`,
    );
  }

  const hits = ranks.filter((rank) => rank > 0).length;
  const firstHits = ranks.filter((rank) => rank === 1).length;
  const meanReciprocalRank =
    ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) /
    (ranks.length || 1);
  const recall = { passed: hits, total: ranks.length };

  console.log(`  recall@1 = ${format({ passed: firstHits, total: ranks.length })}`);
  console.log(`  recall@${config.retrievalTopK} = ${format(recall)}`);
  console.log(`  MRR      = ${meanReciprocalRank.toFixed(3)}\n`);
  return recall;
}

async function scoreAnswers(
  cases: Case[],
  sections: Map<string, string>,
  repeats: number,
): Promise<{ accuracy: Score; escalation: Score }> {
  const latenciesMs: number[] = [];
  let costUsd = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let answerPasses = 0;
  let caughtEscalations = 0;
  let missedEscalations = 0;
  let falseEscalations = 0;
  let erroredCases = 0;
  const runs = cases.length * repeats;
  const expectedEscalations =
    cases.filter((testCase) => testCase.shouldEscalate).length * repeats;
  const casePasses = new Map<string, number>();

  console.log(repeats > 1 ? `answers (${repeats} runs of each case)` : "answers");
  for (const testCase of cases) {
    let passes = 0;
    for (let run = 1; run <= repeats; run++) {
      const label = repeats > 1 ? `${testCase.id}  run=${run}` : testCase.id;
      // One failed request must not throw away the cases that were already paid for.
      const result = await ask(testCase.question).catch((error: Error) => {
        console.log(`  FAIL  ${label}  error: ${error.message}`);
        return null;
      });
      if (!result) {
        erroredCases++;
        continue;
      }
      latenciesMs.push(result.latencyMs);
      costUsd += result.usage.costUsd;
      cacheReadTokens += result.usage.cacheReadTokens;
      cacheWriteTokens += result.usage.cacheWriteTokens;

      const problems = await checkAnswer(testCase, result);
      const verdict = await judge(testCase, result, sections.get(testCase.id)).catch(
        (error: Error) => ({
          passed: false,
          reason: `failed: ${error.message}`,
        }),
      );
      if (!verdict.passed) problems.push(`judge: ${verdict.reason}`);
      if (problems.length === 0) passes++;

      if (testCase.shouldEscalate && result.escalated) caughtEscalations++;
      if (testCase.shouldEscalate && !result.escalated) missedEscalations++;
      if (!testCase.shouldEscalate && result.escalated) falseEscalations++;

      const reached = result.passages.some((passage) => matchesSection(passage, testCase));
      console.log(
        `  ${problems.length === 0 ? "pass" : "FAIL"}  ${label}  ` +
          `outcome=${result.outcome} turns=${result.turns} ` +
          (testCase.expectedSource ? `reached=${reached ? "yes" : "no"} ` : "") +
          `${result.latencyMs}ms $${result.usage.costUsd.toFixed(3)}`,
      );
      for (const problem of problems) console.log(`        ${problem}`);
      if (result.escalated !== testCase.shouldEscalate) {
        console.log(`        escalation expected ${testCase.shouldEscalate}`);
      }
    }
    answerPasses += passes;
    casePasses.set(testCase.id, passes);
  }

  const accuracy = { passed: answerPasses, total: runs };
  const escalation = {
    passed: runs - missedEscalations - falseEscalations - erroredCases,
    total: runs,
  };
  const escalationRecall = { passed: caughtEscalations, total: expectedEscalations };
  const falseEscalationRate = {
    passed: falseEscalations,
    total: runs - expectedEscalations,
  };
  const sortedMs = [...latenciesMs].sort((a, b) => a - b);
  const lowerMs = sortedMs[Math.floor((sortedMs.length - 1) / 2)] ?? 0;
  const upperMs = sortedMs[Math.floor(sortedMs.length / 2)] ?? 0;
  const medianMs = (lowerMs + upperMs) / 2;

  if (repeats > 1) {
    for (const [id, passes] of casePasses) console.log(`  ${passes}/${repeats}  ${id}`);
  }
  console.log(`  answer accuracy       = ${format(accuracy)}`);
  if (repeats > 1) {
    const passedEveryRun = {
      passed: [...casePasses.values()].filter((passes) => passes === repeats).length,
      total: cases.length,
    };
    const flaky = [...casePasses]
      .filter(([, passes]) => passes > 0 && passes < repeats)
      .map(([id]) => id);
    console.log(`${`  answer pass^${repeats}`.padEnd(24)}= ${format(passedEveryRun)}`);
    console.log(`  flaky cases           = ${flaky.length > 0 ? flaky.join(", ") : "none"}`);
  }
  console.log(
    `  escalation accuracy   = ${format(escalation)}` +
      (erroredCases > 0 ? `, errored ${erroredCases}` : ""),
  );
  console.log(`  escalation recall     = ${format(escalationRecall)}`);
  console.log(`  false escalation rate = ${format(falseEscalationRate)}`);
  console.log(
    `  median latency ${(medianMs / 1000).toFixed(1)} s, agent cost ` +
      `$${costUsd.toFixed(2)} total, $${(costUsd / runs).toFixed(3)} a question`,
  );
  console.log(
    `  prompt cache read ${cacheReadTokens} tokens, wrote ${cacheWriteTokens}\n`,
  );
  return { accuracy, escalation };
}

// With three documents, a file-level hit is close to chance, so a hit must match the section.
function matchesSection(passage: Passage, testCase: Case): boolean {
  return passage.source === testCase.expectedSource && inSection(passage.content, testCase);
}

function inSection(content: string, testCase: Case): boolean {
  return content.split("\n").some((line) => line === testCase.expectedSection);
}

export async function sectionText(testCase: Case): Promise<string> {
  const markdown = await readFile(
    new URL(`../docs/${testCase.expectedSource}`, import.meta.url),
    "utf8",
  );
  return chunkMarkdown(markdown)
    .filter((chunk) => inSection(chunk, testCase))
    .join("\n\n");
}

// The judge sees neither passage ids nor the employees table, so these checks run in code.
async function checkAnswer(testCase: Case, result: AgentResult): Promise<string[]> {
  const problems: string[] = [];
  const retrievedIds = new Set(result.passages.map((passage) => passage.chunkId));
  const citedIds = [...result.answer.matchAll(CITATION)].flatMap(
    (match) => match[1]!.split(",").map(Number),
  );

  const unknownIds = citedIds.filter((id) => !retrievedIds.has(id));
  if (unknownIds.length > 0) {
    problems.push(`cites passages it never retrieved: ${unknownIds.join(", ")}`);
  }
  if (testCase.expectedSource && citedIds.length === 0) {
    problems.push("grounded answer cites no passage");
  }

  if (testCase.headcountQuery) {
    const queried = result.trace.some(
      (step) => step.kind === "tool" && step.name === "headcount_query",
    );
    if (!queried) problems.push("never called headcount_query");

    const count = await countEmployees(testCase.headcountQuery);
    if (!statesNumber(result.answer, count)) {
      problems.push(`answer does not state the headcount ${count}`);
    }
  }
  return problems;
}

export function statesNumber(answer: string, value: number): boolean {
  return new RegExp(`\\b${value}\\b`).test(answer.replace(CITATION, " "));
}

export async function judge(
  testCase: Case,
  result: AgentResult,
  section: string | undefined,
): Promise<{ passed: boolean; reason: string }> {
  const passages = result.passages
    .filter((passage) => !matchesSection(passage, testCase))
    .map((passage) => passage.content)
    .join("\n\n");
  const response = await anthropicClient().messages.create({
    model: config.model,
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: judgeSchema },
    },
    // The rubric is a floor, so extra accurate detail must not fail the answer.
    system: section
      ? "You grade an HR assistant's answer against a rubric and the handbook " +
        "text: the section that answers the question and the other passages " +
        "the assistant retrieved. Pass if the answer covers every clause of the " +
        "rubric and the handbook text supports every fact the answer states. " +
        "Additional detail beyond the rubric is expected and must not count " +
        "against the answer when the handbook text supports it; the rubric is a " +
        "floor, not a ceiling. Fail for a missing rubric clause, a claim that " +
        "contradicts the handbook text, or a claim that the handbook text does " +
        "not support. Judge facts only from the handbook text, not from general " +
        "knowledge. Citation markers such as [12] and a referral to HR are not " +
        "claims. Give the reason before the verdict."
      : "You grade an HR assistant's answer against a rubric. Pass if the answer " +
        "covers every clause of the rubric and states nothing that is factually " +
        "wrong. Additional accurate detail beyond the rubric is expected and must " +
        "not count against the answer; the rubric is a floor, not a ceiling. Fail " +
        "only for a missing rubric clause or a claim that is actually incorrect.",
    messages: [
      {
        role: "user",
        content:
          `<question>${testCase.question}</question>\n` +
          (section ? `<section>${section}</section>\n` : "") +
          (section && passages ? `<passages>${passages}</passages>\n` : "") +
          `<rubric>${testCase.rubric}</rubric>\n` +
          `<answer>${result.answer}</answer>`,
      },
    ],
  });

  if (response.stop_reason !== "end_turn") {
    return { passed: false, reason: `stopped at ${response.stop_reason}` };
  }
  const text = response.content.find((block) => block.type === "text");
  if (!text) {
    return { passed: false, reason: "judge returned no text" };
  }
  return JSON.parse(text.text) as { passed: boolean; reason: string };
}

function rate(score: Score): number {
  return score.total > 0 ? score.passed / score.total : 0;
}

function format(score: Score): string {
  return `${rate(score).toFixed(3)} (${score.passed}/${score.total})`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
