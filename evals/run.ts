import { readFile } from "node:fs/promises";
import { pool } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { ingestAll } from "../src/ingest.ts";
import { retrieve, type Passage } from "../src/retrieve.ts";
import { activeEmbeddingModel } from "../src/embeddings.ts";
import {
  anthropicClient,
  ask,
  countEmployees,
  type AgentResult,
} from "../src/agent.ts";
import { config } from "../src/config.ts";

interface Case {
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

const judgeSchema = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["passed", "reason"],
  additionalProperties: false,
} as const;

async function main(): Promise<void> {
  const cases = JSON.parse(
    await readFile(new URL("dataset.json", import.meta.url), "utf8"),
  ) as Case[];
  for (const testCase of cases) {
    if (Boolean(testCase.expectedSource) !== Boolean(testCase.expectedSection)) {
      throw new Error(
        `${testCase.id}: set expectedSource and expectedSection together in evals/dataset.json`,
      );
    }
  }

  await migrate();
  await ingestAll();
  console.log(`embedding model: ${activeEmbeddingModel()}\n`);

  const retrieval = await scoreRetrieval(cases);
  const answers = config.anthropicApiKey ? await scoreAnswers(cases) : null;
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
): Promise<{ accuracy: Score; escalation: Score }> {
  const latenciesMs: number[] = [];
  let costUsd = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let answerPasses = 0;
  let missedEscalations = 0;
  let falseEscalations = 0;
  let erroredCases = 0;
  const expectedEscalations = cases.filter((testCase) => testCase.shouldEscalate).length;

  console.log("answers");
  for (const testCase of cases) {
    // One failed request must not throw away the cases that were already paid for.
    const result = await ask(testCase.question).catch((error: Error) => {
      console.log(`  FAIL  ${testCase.id}  error: ${error.message}`);
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
    const verdict = await judge(testCase, result.answer).catch((error: Error) => ({
      passed: false,
      reason: `failed: ${error.message}`,
    }));
    if (!verdict.passed) problems.push(`judge: ${verdict.reason}`);
    if (problems.length === 0) answerPasses++;

    if (testCase.shouldEscalate && !result.escalated) missedEscalations++;
    if (!testCase.shouldEscalate && result.escalated) falseEscalations++;

    const reached = result.passages.some((passage) => matchesSection(passage, testCase));
    console.log(
      `  ${problems.length === 0 ? "pass" : "FAIL"}  ${testCase.id}  ` +
        `outcome=${result.outcome} turns=${result.turns} ` +
        (testCase.expectedSource ? `reached=${reached ? "yes" : "no"} ` : "") +
        `${result.latencyMs}ms $${result.usage.costUsd.toFixed(3)}`,
    );
    for (const problem of problems) console.log(`        ${problem}`);
    if (result.escalated !== testCase.shouldEscalate) {
      console.log(`        escalation expected ${testCase.shouldEscalate}`);
    }
  }

  const accuracy = { passed: answerPasses, total: cases.length };
  const escalation = {
    passed: cases.length - missedEscalations - falseEscalations - erroredCases,
    total: cases.length,
  };
  const sortedMs = [...latenciesMs].sort((a, b) => a - b);
  const lowerMs = sortedMs[Math.floor((sortedMs.length - 1) / 2)] ?? 0;
  const upperMs = sortedMs[Math.floor(sortedMs.length / 2)] ?? 0;
  const medianMs = (lowerMs + upperMs) / 2;

  console.log(`  answer accuracy     = ${format(accuracy)}`);
  console.log(
    `  escalation accuracy = ${format(escalation)}, ` +
      `missed ${missedEscalations} of ${expectedEscalations}, ` +
      `false ${falseEscalations} of ${cases.length - expectedEscalations}` +
      (erroredCases > 0 ? `, errored ${erroredCases}` : ""),
  );
  console.log(
    `  median latency ${(medianMs / 1000).toFixed(1)} s, agent cost ` +
      `$${costUsd.toFixed(2)} total, $${(costUsd / cases.length).toFixed(3)} a question`,
  );
  console.log(
    `  prompt cache read ${cacheReadTokens} tokens, wrote ${cacheWriteTokens}\n`,
  );
  return { accuracy, escalation };
}

// With three documents, a file-level hit is close to chance, so a hit must match the section.
function matchesSection(passage: Passage, testCase: Case): boolean {
  return (
    passage.source === testCase.expectedSource &&
    passage.content.split("\n").some((line) => line === testCase.expectedSection)
  );
}

// The judge sees neither passage ids nor the employees table, so these checks run in code.
async function checkAnswer(testCase: Case, result: AgentResult): Promise<string[]> {
  const problems: string[] = [];
  const retrievedIds = new Set(result.passages.map((passage) => passage.chunkId));
  const citedIds = [...result.answer.matchAll(/\[(\d+(?:,\s*\d+)*)\]/g)].flatMap(
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
    if (!new RegExp(`\\b${count}\\b`).test(result.answer)) {
      problems.push(`answer does not state the headcount ${count}`);
    }
  }
  return problems;
}

async function judge(
  testCase: Case,
  answer: string,
): Promise<{ passed: boolean; reason: string }> {
  const response = await anthropicClient().messages.create({
    model: config.model,
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: judgeSchema },
    },
    // The rubric is a floor, so extra accurate detail must not fail the answer.
    system:
      "You grade an HR assistant's answer against a rubric. Pass if the answer " +
      "covers every clause of the rubric and states nothing that is factually " +
      "wrong. Additional accurate detail beyond the rubric is expected and must " +
      "not count against the answer; the rubric is a floor, not a ceiling. Fail " +
      "only for a missing rubric clause or a claim that is actually incorrect.",
    messages: [
      {
        role: "user",
        content:
          `<question>${testCase.question}</question>\n` +
          `<rubric>${testCase.rubric}</rubric>\n` +
          `<answer>${answer}</answer>`,
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

await main();
