# HR Assistant

Ask an HR question in plain language. An agent searches the policy handbook,
queries headcount with SQL, and either answers with citations or hands the
question to a human.

> The handbook in `docs/` and the employee rows are made up. They describe a
> generic European manufacturer, not any real company. The leave and working-time
> rules follow German statute so the answers read realistically.

## Stack

| | |
| --- | --- |
| Retrieval | PostgreSQL + `pgvector`, HNSW cosine |
| Agent | Claude, three tools: `search_policies`, `headcount_query`, `escalate_to_hr` |
| API | Node 22, Express, TypeScript |
| Web | React 19, Vite |
| Tests | `node:test`, no framework |
| Evals | Retrieval recall, LLM-judged answers, escalation accuracy |
| CI | GitHub Actions — typecheck, tests, build, evals, image to GHCR |

Why it's built this way: `ARCHITECTURE.md`.

## Results

Twelve cases, scored by `npm run eval`. CI fails below the floor.

| Metric | Floor | Last run |
| --- | --- | --- |
| Retrieval recall@5 | 0.85 | 1.000 |
| Answer accuracy | 0.80 | 1.000 |
| Escalation accuracy | 1.00 | 1.000 |

Median 5.4 s per answer, about $0.02 a question. The retrieval number uses the
local embedder, so you can reproduce it with no API keys at all.

## Before you start

- **Node 22+.** The scripts use `--experimental-strip-types` and
  `--env-file-if-exists`. Node 20 fails with a confusing error. Check with
  `node --version`.
- **Docker, or Postgres 17 with `pgvector`.**
- **An Anthropic API key** to answer questions. Retrieval and ingestion work
  without one.

## Run it — Docker

```sh
cp .env.example .env          # add your key
docker compose up --build
```

http://localhost:3000. First boot creates the schema and ingests the handbook.
The database lives in a volume, so later starts skip that.

## Run it — locally, macOS

```sh
brew install postgresql@17 pgvector
brew services start postgresql@17

# Apple Silicon path. Intel Macs: /usr/local
PSQL=/opt/homebrew/opt/postgresql@17/bin/psql

# SUPERUSER once, so the app can CREATE EXTENSION vector
$PSQL -d postgres -c "CREATE ROLE hr LOGIN PASSWORD 'hr' SUPERUSER;"
$PSQL -d postgres -c "CREATE DATABASE hr OWNER hr;"

cp .env.example .env          # add your key
npm install
npm install --prefix web
npm run web:build             # skip this and you get a blank page
npm run dev
```

Check it:

```sh
curl -s localhost:3000/healthz
# {"ok":true,"chunks":14,"embedder":"local","model":"claude-opus-5"}
```

`chunks` above zero means the handbook is loaded. Edited something in `docs/`?
Run `npm run ingest`.

Front-end work: `npm run web:dev` gives you Vite on :5173 with hot reload. Keep
`npm run dev` running too.

## Configuration

Everything is an environment variable with a working default, so `docker compose
up` needs only a key.

| | |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required to answer. Retrieval and ingestion work without it |
| `DATABASE_URL` | Defaults to `postgres://hr:hr@localhost:5432/hr` |
| `PORT` | Defaults to 3000 |
| `MODEL` | Defaults to `claude-opus-5`. Must be priced in `src/config.ts`, so the trace can never cost a question with the wrong price list |
| `VOYAGE_API_KEY` | Optional. Unset uses the local embedder |
| `API_URL` | Vite dev proxy target. Only needed if the API is not on port 3000 |

Two things are fixed rather than configured. `embeddingDimensions` is baked into
the `VECTOR(1024)` column, so changing it needs a fresh database. Commands read
`docs/` and `web/dist` from the working directory, so run them from the repo
root.

## Endpoints

| | |
| --- | --- |
| `GET /healthz` | Corpus size, embedder, model |
| `GET /meta` | Live system prompt, tool schemas, counts |
| `GET /stats` | Answer volume, escalation rate, p50 and p95 latency |
| `POST /ask` | `{"question": "..."}` → answer, passages, usage, trace |

```sh
curl -s localhost:3000/ask -H 'content-type: application/json' \
  -d '{"question":"How many leave days can I carry over?"}'
```

The UI shows the same thing: answer, metrics, agent trace, retrieved passages
with scores.

## Tests

```sh
npm test
```

Unit tests over the pure parts: chunking, the local embedder, and the filter
builder behind `headcount_query`. No database and no API key. Runs in a second.

## Evals

Tests say the code does what it should. Evals say the agent answers what it
should. Both gate CI.

```sh
npm run eval
```

Scores every case in `evals/dataset.json` and exits non-zero if a metric drops
below its floor. Answered a real question badly? Add it as a case.

No API key means retrieval recall only — that's how CI stays useful on a fork.
A full run costs about $0.50.

## When it breaks

| Symptom | Fix |
| --- | --- |
| `ECONNREFUSED ... 5432` | Postgres isn't running |
| `401 ... invalid x-api-key` | `.env` still has the placeholder |
| `"chunks":0` | `npm run ingest` |
| Blank page | `npm run web:build` |
| `bad option: --experimental-strip-types` | Node older than 22 |
| `type "vector" does not exist` | `pgvector` missing, or built for another Postgres |

Stop with `docker compose down`, or `brew services stop postgresql@17`.

## Deploying

Every push to `main` publishes `ghcr.io/mazzsva/hr-assistant:latest` once the
checks pass. `deploy/k8s.yaml` runs that image: two replicas, probes on
`/healthz`, and a grace period long enough to finish an answer in flight. Create
the secret first.

```sh
kubectl create secret generic hr-assistant \
  --from-literal=DATABASE_URL=... --from-literal=ANTHROPIC_API_KEY=...
kubectl apply -f deploy/k8s.yaml
```

## Layout

```
src/
  config.ts      Environment and model config
  db.ts          Pool and pgvector serialization
  migrate.ts     Schema and seed data
  chunk.ts       Heading-aware markdown chunking
  embeddings.ts  Voyage, with a local fallback
  ingest.ts      Chunk, embed, upsert
  retrieve.ts    Cosine top-k
  agent.ts       Tools and the agent loop
  server.ts      API, first-boot ingest, static hosting
test/            Unit tests for the pure parts
evals/
  dataset.json   Questions, rubrics, expected escalation
  run.ts         Metrics, thresholds, LLM judge
docs/            The handbook
deploy/k8s.yaml  Deployment and service
web/src/
  App.tsx        State and layout, nothing else
  lib/           API calls, formatting, examples
  components/    One component and one stylesheet each
  styles/        Design tokens
```

## Four decisions

**Retrieval is a tool, not a pre-step.** The agent picks when and what to search.
Multi-part questions get several narrow searches. Questions with no policy answer
get none.

**Headcount is SQL.** Counting people is a query. A vector search over prose will
never answer it right.

**Escalation is a real outcome.** "The handbook doesn't cover this" has somewhere
to go, so the failure mode is a ticket instead of an invented policy. The tool
requires the model to state what the handbook does cover, which is what stops the
employee getting a bare ticket number. Gated at 100% in CI.

**Embeddings are pluggable.** `voyage-3` with `VOYAGE_API_KEY`, otherwise a local
hashed-bigram embedder. Worse, but it means ingestion and CI need no external
service.
