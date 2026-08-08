import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pool, toVector } from "./db.ts";
import { chunkMarkdown } from "./chunk.ts";
import { embed, activeProvider } from "./embeddings.ts";
import { migrate } from "./migrate.ts";

const docsDirectory = path.resolve(process.cwd(), "docs");

export async function ingestAll(): Promise<{ documents: number; chunks: number }> {
  const files = (await readdir(docsDirectory)).filter((name) => name.endsWith(".md"));
  let chunkCount = 0;

  for (const file of files) {
    const markdown = await readFile(path.join(docsDirectory, file), "utf8");
    chunkCount += await ingestDocument(file, markdown);
  }

  return { documents: files.length, chunks: chunkCount };
}

async function ingestDocument(source: string, markdown: string): Promise<number> {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? source;
  const chunks = chunkMarkdown(markdown);
  const embeddings = await embed(chunks, "document");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents (source, title, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (source) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
       RETURNING id`,
      [source, title],
    );
    const documentId = rows[0]!.id;

    // Re-ingestion replaces the document's chunks rather than appending.
    await client.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);

    for (const [ordinal, content] of chunks.entries()) {
      await client.query(
        `INSERT INTO chunks (document_id, ordinal, content, embedding)
         VALUES ($1, $2, $3, $4)`,
        [documentId, ordinal, content, toVector(embeddings[ordinal]!)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return chunks.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  const result = await ingestAll();
  console.log(
    `ingested ${result.chunks} chunks from ${result.documents} documents ` +
      `using the ${activeProvider()} embedder`,
  );
  await pool.end();
}
