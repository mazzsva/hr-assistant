import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { pool, toVector } from "./db.ts";
import { chunkMarkdown } from "./chunk.ts";
import { embed, activeEmbeddingModel } from "./embeddings.ts";
import { migrate } from "./migrate.ts";

const docsDirectory = path.resolve(process.cwd(), "docs");

interface Document {
  source: string;
  title: string;
  chunks: string[];
  contentHash: string;
  embeddingModel: string;
}

export async function ingestAll(): Promise<void> {
  const sources = (await readdir(docsDirectory)).filter((name) => name.endsWith(".md"));
  const embeddingModel = activeEmbeddingModel();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Replicas boot together, so the second waits here and then skips what the first embedded.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('ingest'))`);
    const { rows } = await client.query<{
      source: string;
      content_hash: string;
      embedding_model: string;
    }>(`SELECT source, content_hash, embedding_model FROM documents`);
    const stored = new Map(rows.map((row) => [row.source, row]));

    let documentCount = 0;
    let chunkCount = 0;
    let unchanged = 0;

    for (const source of sources) {
      const markdown = await readFile(path.join(docsDirectory, source), "utf8");
      const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? source;
      const chunks = chunkMarkdown(markdown);
      // Hashing the chunks instead of the file also catches a change to the chunker.
      const contentHash = createHash("sha256")
        .update(JSON.stringify([title, chunks]))
        .digest("hex");

      const previous = stored.get(source);
      if (
        previous?.content_hash === contentHash &&
        previous.embedding_model === embeddingModel
      ) {
        unchanged++;
        continue;
      }
      await writeDocument(client, { source, title, chunks, contentHash, embeddingModel });
      documentCount++;
      chunkCount += chunks.length;
    }

    // A policy deleted from docs/ must stop answering questions.
    const { rowCount } = await client.query(
      `DELETE FROM documents WHERE source <> ALL($1)`,
      [sources],
    );
    await client.query("COMMIT");

    console.log(
      `ingested ${chunkCount} chunks from ${documentCount} documents ` +
        `with ${embeddingModel}, ${unchanged} unchanged, ${rowCount ?? 0} removed`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function writeDocument(client: PoolClient, document: Document): Promise<void> {
  const embeddings = await embed(document.chunks, "document");

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO documents (source, title, content_hash, embedding_model, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (source) DO UPDATE
       SET title = EXCLUDED.title,
           content_hash = EXCLUDED.content_hash,
           embedding_model = EXCLUDED.embedding_model,
           updated_at = now()
     RETURNING id`,
    [document.source, document.title, document.contentHash, document.embeddingModel],
  );
  const documentId = rows[0]!.id;

  // A changed document gets new chunk ids, so a logged citation never points to rewritten text.
  await client.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);

  for (const [ordinal, content] of document.chunks.entries()) {
    await client.query(
      `INSERT INTO chunks (document_id, ordinal, content, embedding)
       VALUES ($1, $2, $3, $4)`,
      [documentId, ordinal, content, toVector(embeddings[ordinal]!)],
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await migrate();
  await ingestAll();
  await pool.end();
}
