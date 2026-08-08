import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { ingestAll } from "../src/ingest.ts";
import { retrieve } from "../src/retrieve.ts";
import { activeProvider } from "../src/embeddings.ts";
import { ask } from "../src/agent.ts";
import { config } from "../src/config.ts";

interface Case {
  id: string;
  question: string;
  expectedSource: string | null;
  rubric: string;
  shouldEscalate: boolean;
}

// Thresholds are the gate: CI fails when a change drops either metric below its
// floor, so retrieval and answer regressions surface on the pull request.
const RETRIEVAL_FLOOR = 0.85;
const ANSWER_FLOOR = 0.8;
const ESCALATION_FLOOR = 1.0;

const here = path.dirname(fileURLToPath(import.meta.url));

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
    await readFile(path.join(here, "dataset.json"), "utf8"),
  ) as Case[];

  await migrate();
  await ingestAll();

  const grounded = cases.filter((testCase) => testCase.expectedSource !== null);
  let retrievalHits = 0;

  console.log(`embedder: ${activeProvider()}\n`);
  console.log("retrieval");
  for (const testCase of grounded) {
    const passages = await retrieve(testCase.question);
    const hit = passages.some((passage) => passage.source === testCase.expectedSource);
    if (hit) retrievalHits++;
    console.log(
      `  ${hit ? "pass" : "FAIL"}  ${testCase.id}  ` +
        `top=${passages[0]?.source ?? "none"} ` +
        `sim=${passages[0]?.similarity.toFixed(3) ?? "-"}`,
    );
  }
  const retrievalRecall = grounded.length ? retrievalHits / grounded.length : 1;
  console.log(`  recall@${config.retrievalTopK} = ${retrievalRecall.toFixed(3)}\n`);

  let answerScore = 1;
  let escalationScore = 1;

  if (!config.anthropicApiKey) {
    console.log("answers: skipped (ANTHROPIC_API_KEY not set)\n");
  } else {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    let answerPasses = 0;
    let escalationPasses = 0;

    console.log("answers");
    for (const testCase of cases) {
      const result = await ask(testCase.question);
      const verdict = await judge(client, testCase, result.answer);

      if (verdict.passed) answerPasses++;
      if (result.escalated === testCase.shouldEscalate) escalationPasses++;

      console.log(
        `  ${verdict.passed ? "pass" : "FAIL"}  ${testCase.id}  ` +
          `escalated=${result.escalated} turns=${result.turns} ` +
          `${result.latencyMs}ms`,
      );
      if (!verdict.passed) console.log(`        ${verdict.reason}`);
      if (result.escalated !== testCase.shouldEscalate) {
        console.log(`        escalation expected ${testCase.shouldEscalate}`);
      }
    }

    answerScore = answerPasses / cases.length;
    escalationScore = escalationPasses / cases.length;
    console.log(`  answer accuracy   = ${answerScore.toFixed(3)}`);
    console.log(`  escalation accuracy = ${escalationScore.toFixed(3)}\n`);
  }

  const failures = [
    retrievalRecall < RETRIEVAL_FLOOR
      ? `retrieval recall ${retrievalRecall.toFixed(3)} < ${RETRIEVAL_FLOOR}`
      : null,
    answerScore < ANSWER_FLOOR
      ? `answer accuracy ${answerScore.toFixed(3)} < ${ANSWER_FLOOR}`
      : null,
    escalationScore < ESCALATION_FLOOR
      ? `escalation accuracy ${escalationScore.toFixed(3)} < ${ESCALATION_FLOOR}`
      : null,
  ].filter((entry): entry is string => entry !== null);

  await pool.end();

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log("all thresholds met");
}

async function judge(
  client: Anthropic,
  testCase: Case,
  answer: string,
): Promise<{ passed: boolean; reason: string }> {
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: judgeSchema },
    },
    system:
      "You grade an HR assistant's answer against a rubric. Pass only if the " +
      "answer satisfies every clause of the rubric and adds no claim the rubric " +
      "does not support. Extra correct detail is fine; a wrong or invented " +
      "detail is a failure.",
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

  const text = response.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    return { passed: false, reason: "judge returned no text" };
  }
  return JSON.parse(text.text) as { passed: boolean; reason: string };
}

await main();
