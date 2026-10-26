import path from "node:path";
import express from "express";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { migrate } from "./migrate.ts";
import { ingestAll } from "./ingest.ts";
import { ask, tools, systemPrompt, AgentError } from "./agent.ts";
import { activeProvider } from "./embeddings.ts";

// Resolved from the working directory, so source, dist, and image agree.
const webDist = path.resolve(process.cwd(), "web", "dist");

const MAX_QUESTION_LENGTH = 1000;

const app = express();
app.use(express.json());

app.get("/healthz", async (_request, response) => {
  const { rows } = await pool.query<{ chunks: string }>(
    `SELECT count(*)::text AS chunks FROM chunks`,
  );
  response.json({
    ok: true,
    chunks: Number(rows[0]!.chunks),
    embedder: activeProvider(),
    model: config.model,
  });
});

// Exposes the agent's configuration, so the UI can show it without the source.
app.get("/meta", async (_request, response) => {
  const { rows } = await pool.query<{
    documents: string;
    chunks: string;
    employees: string;
    answered: string;
  }>(
    `SELECT (SELECT count(*) FROM documents)::text  AS documents,
            (SELECT count(*) FROM chunks)::text     AS chunks,
            (SELECT count(*) FROM employees)::text  AS employees,
            (SELECT count(*) FROM answers
             WHERE outcome = 'answered')::text      AS answered`,
  );

  response.json({
    model: config.model,
    embedder: activeProvider(),
    embeddingDimensions: config.embeddingDimensions,
    retrievalTopK: config.retrievalTopK,
    systemPrompt,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    })),
    corpus: {
      documents: Number(rows[0]!.documents),
      chunks: Number(rows[0]!.chunks),
      employees: Number(rows[0]!.employees),
      answered: Number(rows[0]!.answered),
    },
  });
});

// The last 24 hours only, because an all-time average hides a sudden fall in the escalation rate.
app.get("/stats", async (_request, response) => {
  const { rows } = await pool.query<{
    questions: string;
    escalation_rate: number;
    failure_rate: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    mean_cost_usd: number;
  }>(
    `SELECT count(*)::text AS questions,
            coalesce(avg((outcome = 'escalated')::int), 0)::float8 AS escalation_rate,
            coalesce(avg((outcome IN ('refused', 'incomplete', 'error'))::int), 0)::float8
              AS failure_rate,
            coalesce(percentile_cont(0.5)
              WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p50_latency_ms,
            coalesce(percentile_cont(0.95)
              WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p95_latency_ms,
            coalesce(avg(cost_usd), 0)::float8 AS mean_cost_usd
     FROM answers
     WHERE created_at > now() - interval '24 hours'`,
  );

  response.json({
    questions: Number(rows[0]!.questions),
    escalationRate: rows[0]!.escalation_rate,
    failureRate: rows[0]!.failure_rate,
    p50LatencyMs: Math.round(rows[0]!.p50_latency_ms),
    p95LatencyMs: Math.round(rows[0]!.p95_latency_ms),
    meanCostUsd: rows[0]!.mean_cost_usd,
  });
});

app.post("/ask", async (request, response) => {
  // Express 5 leaves the body undefined when the request is not JSON.
  const question = String(request.body?.question ?? "").trim();
  if (!question) {
    response.status(400).json({ error: "question is required" });
    return;
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    response
      .status(400)
      .json({ error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer` });
    return;
  }

  if (config.dailyBudgetUsd !== undefined) {
    const { rows } = await pool.query<{ spent_usd: number }>(
      `SELECT coalesce(sum(cost_usd), 0)::float8 AS spent_usd
       FROM answers
       WHERE created_at > now() - interval '24 hours'`,
    );
    if (rows[0]!.spent_usd >= config.dailyBudgetUsd) {
      response
        .status(429)
        .json({ error: `the daily budget of $${config.dailyBudgetUsd} is spent` });
      return;
    }
  }

  const startedAt = Date.now();
  try {
    const result = await ask(question);
    // A failed log write must not cost the employee the answer.
    await pool
      .query(
        `INSERT INTO answers (question, answer, chunk_ids, outcome, latency_ms, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          question,
          result.answer,
          result.passages.map((passage) => passage.chunkId),
          result.outcome,
          result.latencyMs,
          result.usage.costUsd,
        ],
      )
      .catch((error: unknown) => console.error(error));
    response.json(result);
  } catch (error) {
    console.error(error);
    const message = (error as Error).message;
    // A run that throws still counts toward failureRate and the latency percentiles.
    await pool
      .query(
        `INSERT INTO answers (question, answer, outcome, latency_ms, cost_usd)
         VALUES ($1, $2, 'error', $3, $4)`,
        [
          question,
          message,
          Date.now() - startedAt,
          error instanceof AgentError ? error.usage.costUsd : null,
        ],
      )
      .catch((error: unknown) => console.error(error));
    // An internal tool, so the UI shows the real cause instead of a generic message.
    response.status(500).json({ error: message });
  }
});

app.use(express.static(webDist));

await migrate();
// A new image can ship a changed handbook, so every boot syncs docs/.
await ingestAll();

const server = app.listen(config.port, () => {
  console.log(`listening on http://localhost:${config.port}`);
});

// Kubernetes sends SIGTERM on every rollout, so in-flight answers finish first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
