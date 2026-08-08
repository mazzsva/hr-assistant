import path from "node:path";
import express from "express";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { migrate } from "./migrate.ts";
import { ingestAll } from "./ingest.ts";
import { ask, tools, systemPrompt } from "./agent.ts";
import { activeProvider } from "./embeddings.ts";

// Resolved from the working directory so the path is the same whether the
// server runs from source, from dist/, or from the container image.
const webDist = path.resolve(process.cwd(), "web", "dist");

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

// Exposes the agent's configuration so the UI can show what the model is allowed
// to do without anyone opening the source.
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

app.post("/ask", async (request, response) => {
  const question = String((request.body as { question?: unknown }).question ?? "").trim();
  if (!question) {
    response.status(400).json({ error: "question is required" });
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
app.get(/^(?!\/(ask|healthz|meta)).*/, (_request, response) => {
  response.sendFile(path.join(webDist, "index.html"));
});

// A container starting against an empty volume has no corpus, so the handbook is
// ingested on first boot. Re-ingesting is an explicit `npm run ingest`.
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
app.listen(config.port, () => {
  console.log(`listening on http://localhost:${config.port}`);
});
