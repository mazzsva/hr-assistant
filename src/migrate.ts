import { pathToFileURL } from "node:url";
import { pool } from "./db.ts";
import { config } from "./config.ts";

const statements = [
  `CREATE EXTENSION IF NOT EXISTS vector`,

  `CREATE TABLE IF NOT EXISTS documents (
     id               BIGSERIAL PRIMARY KEY,
     source           TEXT NOT NULL UNIQUE,
     title            TEXT NOT NULL,
     content_hash     TEXT NOT NULL,
     embedding_model  TEXT NOT NULL,
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS chunks (
     id           BIGSERIAL PRIMARY KEY,
     document_id  BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     ordinal      INTEGER NOT NULL,
     content      TEXT NOT NULL,
     embedding    VECTOR(${config.embeddingDimensions}) NOT NULL,
     UNIQUE (document_id, ordinal)
   )`,

  `CREATE INDEX IF NOT EXISTS chunks_embedding_idx
     ON chunks USING hnsw (embedding vector_cosine_ops)`,

  // Structured HR data the agent queries with SQL instead of retrieval.
  `CREATE TABLE IF NOT EXISTS employees (
     id          BIGSERIAL PRIMARY KEY,
     department  TEXT NOT NULL,
     location    TEXT NOT NULL,
     level       TEXT NOT NULL,
     started_on  DATE NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS answers (
     id           BIGSERIAL PRIMARY KEY,
     question     TEXT NOT NULL,
     answer       TEXT NOT NULL,
     chunk_ids    BIGINT[] NOT NULL DEFAULT '{}',
     outcome      TEXT NOT NULL
                  CHECK (outcome IN ('answered', 'escalated', 'refused', 'incomplete', 'error')),
     latency_ms   INTEGER NOT NULL,
     cost_usd     DOUBLE PRECISION,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS answers_created_at_idx ON answers (created_at)`,

  // Tables from before these columns existed get them here, and the empty hash forces one re-embed.
  `ALTER TABLE documents
     ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT ''`,

  `ALTER TABLE answers
     ADD COLUMN IF NOT EXISTS outcome TEXT,
     ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION`,
];

// Level steps on n / 3 and location on n, so every location has every level.
const seedEmployees = `
  INSERT INTO employees (department, location, level, started_on)
  SELECT d.name, l.name, lv.name, DATE '2024-01-01' + (n * 11 % 500)
  FROM generate_series(1, 40) AS n
  CROSS JOIN LATERAL (SELECT (ARRAY['Production','Engineering','People','Logistics'])[1 + n % 4] AS name) d
  CROSS JOIN LATERAL (SELECT (ARRAY['Leipzig','Berlin','Prague'])[1 + n % 3] AS name) l
  CROSS JOIN LATERAL (SELECT (ARRAY['Associate','Senior','Lead'])[1 + (n / 3) % 3] AS name) lv
  WHERE NOT EXISTS (SELECT 1 FROM employees)
`;

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Replicas boot together, and two concurrent CREATE EXTENSION or seed runs collide.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('migrate'))`);
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query(seedEmployees);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await migrate();
  console.log("migrated");
  await pool.end();
}
