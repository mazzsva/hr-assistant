import path from "node:path";
import express from "express";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { migrate } from "./migrate.ts";
import { ask } from "./agent.ts";
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
app.get(/^(?!\/(ask|healthz)).*/, (_request, response) => {
  response.sendFile(path.join(webDist, "index.html"));
});

await migrate();
app.listen(config.port, () => {
  console.log(`listening on http://localhost:${config.port}`);
});
