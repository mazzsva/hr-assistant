import { pool } from "./db.ts";
import { config } from "./config.ts";

const statements = [
  `CREATE EXTENSION IF NOT EXISTS vector`,

  `CREATE TABLE IF NOT EXISTS documents (
     id          BIGSERIAL PRIMARY KEY,
     source      TEXT NOT NULL UNIQUE,
     title       TEXT NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
     escalated    BOOLEAN NOT NULL DEFAULT false,
     latency_ms   INTEGER NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

const seedEmployees = `
  INSERT INTO employees (department, location, level, started_on)
  SELECT d.name, l.name, lv.name, DATE '2024-01-01' + (n * 11 % 500)
  FROM generate_series(1, 40) AS n
  CROSS JOIN LATERAL (SELECT (ARRAY['Production','Engineering','People','Logistics'])[1 + n % 4] AS name) d
  CROSS JOIN LATERAL (SELECT (ARRAY['Leipzig','Berlin','Prague'])[1 + n % 3] AS name) l
  CROSS JOIN LATERAL (SELECT (ARRAY['Associate','Senior','Lead'])[1 + n % 3] AS name) lv
  WHERE NOT EXISTS (SELECT 1 FROM employees)
`;

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query(seedEmployees);
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  console.log("migrated");
  await pool.end();
}
