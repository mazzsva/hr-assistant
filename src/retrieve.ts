import { pool, toVector } from "./db.ts";
import { config } from "./config.ts";
import { embed, activeEmbeddingModel } from "./embeddings.ts";

export interface Passage {
  chunkId: number;
  source: string;
  title: string;
  content: string;
  // Cosine similarity to the search query, which can differ from the employee's question.
  similarity: number;
}

export async function retrieve(query: string): Promise<Passage[]> {
  const [embedding] = await embed([query], "query");

  // Vectors from another model are not comparable, so their chunks never rank.
  const { rows } = await pool.query<{
    id: string;
    source: string;
    title: string;
    content: string;
    similarity: number;
  }>(
    `SELECT c.id, d.source, d.title, c.content,
            1 - (c.embedding <=> $1) AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE d.embedding_model = $2
     ORDER BY c.embedding <=> $1
     LIMIT $3`,
    [toVector(embedding!), activeEmbeddingModel(), config.retrievalTopK],
  );

  return rows.map((row) => ({
    chunkId: Number(row.id),
    source: row.source,
    title: row.title,
    content: row.content,
    similarity: row.similarity,
  }));
}

export function renderPassages(passages: Passage[]): string {
  return passages
    .map(
      (passage) =>
        `<passage id="${passage.chunkId}" source="${passage.source}">\n` +
        `${passage.content}\n</passage>`,
    )
    .join("\n\n");
}
