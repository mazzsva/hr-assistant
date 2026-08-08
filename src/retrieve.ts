import { pool, toVector } from "./db.ts";
import { config } from "./config.ts";
import { embed } from "./embeddings.ts";

export interface Passage {
  chunkId: number;
  source: string;
  title: string;
  content: string;
  similarity: number;
}

export async function retrieve(
  query: string,
  topK: number = config.retrievalTopK,
): Promise<Passage[]> {
  const [embedding] = await embed([query], "query");

  const { rows } = await pool.query<{
    id: string;
    source: string;
    title: string;
    content: string;
    distance: number;
  }>(
    `SELECT c.id, d.source, d.title, c.content,
            c.embedding <=> $1 AS distance
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     ORDER BY c.embedding <=> $1
     LIMIT $2`,
    [toVector(embedding!), topK],
  );

  return rows.map((row) => ({
    chunkId: Number(row.id),
    source: row.source,
    title: row.title,
    content: row.content,
    similarity: 1 - Number(row.distance),
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
