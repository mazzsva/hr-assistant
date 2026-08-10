import path from "node:path";
import express from "express";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { migrate } from "./migrate.ts";
import { ingestAll } from "./ingest.ts";
import { ask, tools, systemPrompt } from "./agent.ts";
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
            (SELECT count(*) FROM answers)::text    AS answered`,
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

// Reads back what /ask writes, so the same run that answers also reports on itself.
app.get("/stats", async (_request, response) => {
  const { rows } = await pool.query<{
    answered: string;
    escalation_rate: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
  }>(
    `SELECT count(*)::text AS answered,
            coalesce(avg(escalated::int), 0)::float8 AS escalation_rate,
            coalesce(percentile_cont(0.5)
              WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p50_latency_ms,
            coalesce(percentile_cont(0.95)
              WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p95_latency_ms
     FROM answers`,
  );

  response.json({
    answered: Number(rows[0]!.answered),
    escalationRate: rows[0]!.escalation_rate,
    p50LatencyMs: Math.round(rows[0]!.p50_latency_ms),
    p95LatencyMs: Math.round(rows[0]!.p95_latency_ms),
  });
});

app.post("/ask", async (request, response) => {
  const question = String((request.body as { question?: unknown }).question ?? "").trim();
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

  try {
    const result = await ask(question);
    await pool.query(
      `INSERT INTO answers (question, answer, chunk_ids, escalated, latency_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        question,
        result.answer,
        result.passages.map((passage) => passage.chunkId),
        result.escalated,
        result.latencyMs,
      ],
    );
    response.json(result);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: (error as Error).message });
  }
});

app.use(express.static(webDist));
app.get(/^(?!\/(ask|healthz|meta|stats)).*/, (_request, response) => {
  response.sendFile(path.join(webDist, "index.html"));
});

// An empty volume has no corpus, so first boot ingests the handbook.
async function bootstrap(): Promise<void> {
  await migrate();

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM chunks`,
  );
  if (Number(rows[0]!.count) === 0) {
    const result = await ingestAll();
    console.log(
      `ingested ${result.chunks} chunks from ${result.documents} documents`,
    );
  }
}

await bootstrap();
const server = app.listen(config.port, () => {
  console.log(`listening on http://localhost:${config.port}`);
});

// Kubernetes sends SIGTERM on every rollout, so in-flight answers finish first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
