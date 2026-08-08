# HR Assistant

An internal HR question-answering service. Employees ask a question in plain
language; an agent retrieves passages from the policy handbook, queries headcount
data with SQL, and either answers with citations or opens a ticket for a human HR
partner.

> The handbook in `docs/` and the employee rows in `migrate.ts` are fictional,
> written for this project. They describe a generic European manufacturing
> employer and are not any real company's policies or data. The leave, notice,
> and working-time rules are modelled on German statute so the answers are
> realistic to read.

## What it is

| Layer | Choice |
| --- | --- |
| Retrieval | PostgreSQL + `pgvector`, HNSW cosine index |
| Agent | Claude with a tool loop: `search_policies`, `headcount_query`, `escalate_to_hr` |
| API | Node 22 + Express, TypeScript |
| Front end | React 19 + Vite |
| Evaluation | Retrieval recall, an LLM-judged answer score, and escalation accuracy |
| CI | GitHub Actions: typecheck, web build, evals against a live Postgres, image build |
| Deployment | Docker + Compose |

`ARCHITECTURE.md` covers the decisions behind these choices and what comes next.

## Requirements

- **Node 22 or newer.** The scripts use `--experimental-strip-types` to run
  TypeScript directly and `--env-file-if-exists` to read `.env`. Neither flag
  exists on Node 20, and the failure there is a confusing one. Check with
  `node --version`.
- **Either Docker, or PostgreSQL 17 with the `pgvector` extension.** Both routes
  are below.
- **An Anthropic API key**, for answering questions. Retrieval, ingestion, and
  the retrieval half of the eval all run without one.

## Run it with Docker

```sh
cp .env.example .env          # then put your key in ANTHROPIC_API_KEY
docker compose up --build
```

Open http://localhost:3000.

The first boot creates the schema and ingests the handbook, which takes a few
seconds. Compose keeps the database in a named volume, so later starts skip
both steps.

## Run it locally (macOS)

```sh
# 1. Database
brew install postgresql@17 pgvector
brew services start postgresql@17

# On Apple Silicon. Intel Macs use /usr/local instead of /opt/homebrew.
PSQL=/opt/homebrew/opt/postgresql@17/bin/psql

# SUPERUSER is needed once, so the app can run CREATE EXTENSION vector.
$PSQL -d postgres -c "CREATE ROLE hr LOGIN PASSWORD 'hr' SUPERUSER;"
$PSQL -d postgres -c "CREATE DATABASE hr OWNER hr;"

# 2. Application
cp .env.example .env          # then put your key in ANTHROPIC_API_KEY
npm install
npm install --prefix web
npm run web:build             # the API serves this build; skipping it gives a blank page
npm run dev                   # API and UI on :3000
```

Every script reads `.env` through Node's `--env-file-if-exists`, so there is no
dotenv dependency and no export step.

Confirm it came up:

```sh
curl -s localhost:3000/healthz
# {"ok":true,"chunks":14,"embedder":"local","model":"claude-opus-5"}
```

`chunks` should be greater than zero. The server ingests the handbook on first
boot when it finds an empty corpus; `npm run ingest` re-runs that by hand after
you edit anything in `docs/`.

For front-end work, `npm run web:dev` serves Vite on :5173 with hot reload and
proxies `/ask` and `/meta` to the API — keep `npm run dev` running alongside it.

## Using it

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, corpus size, active embedder and model |
| `GET /meta` | The live system prompt, tool schemas, and corpus counts |
| `POST /ask` | `{"question": "..."}` → answer, retrieved passages, usage, and trace |

```sh
curl -s localhost:3000/ask \
  -H 'content-type: application/json' \
  -d '{"question":"How many leave days can I carry over?"}'
```

The UI shows the same payload: the answer, a metrics strip, the agent trace, and
every retrieved passage with its similarity score.

## Evaluating

```sh
npm run eval
```

The run re-ingests the handbook, scores every case in `evals/dataset.json`, and
exits non-zero when a metric falls below its floor. Add a case whenever a real
question is answered badly — the dataset is the regression suite.

Without `ANTHROPIC_API_KEY` it reports retrieval recall only and skips the answer
judge, which is how it stays useful in CI on a fork. A full run calls the API
once per case plus once per judgement, so expect roughly $0.50 in usage.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED ... 5432` | Postgres is not running. `brew services start postgresql@17`. |
| `401 ... invalid x-api-key` | `.env` still holds the placeholder key. |
| `"chunks":0` in `/healthz` | Ingestion did not run. `npm run ingest`. |
| Blank page at :3000 | `npm run web:build` has not been run. |
| `bad option: --experimental-strip-types` | Node is older than 22. |
| `type "vector" does not exist` | `pgvector` is missing, or was installed for a different Postgres version. |

Stop everything with `docker compose down`, or `brew services stop postgresql@17`
for the local route.

## Layout

```
src/
  config.ts      Environment and model configuration
  db.ts          Connection pool and pgvector serialization
  migrate.ts     Schema and seed data
  chunk.ts       Heading-aware markdown chunking
  embeddings.ts  Voyage provider with a deterministic local fallback
  ingest.ts      Chunk, embed, and upsert the handbook
  retrieve.ts    Cosine top-k search
  agent.ts       Tool definitions and the agent loop
  server.ts      HTTP API, first-boot ingestion, and static hosting
evals/
  dataset.json   Questions, rubrics, and expected escalation behaviour
  run.ts         Metrics, thresholds, and the LLM judge
docs/            The policy handbook the assistant answers from
web/src/
  App.tsx        State and layout only
  lib/           API calls, formatting, and the example questions
  components/    One component and one stylesheet per piece of the page
  styles/        Design tokens, imported once
```

## Design notes

**Retrieval is a tool, not a pre-step.** The agent decides when and what to
search, so a multi-part question produces several narrow searches instead of one
broad one. A question with no policy answer produces no search at all.

**Headcount is SQL, not retrieval.** Counting people is a query, and a vector
search over prose will never answer it correctly. Splitting the two removes a
whole class of confident wrong answers.

**Escalation is a first-class outcome.** The agent has an explicit path for "the
handbook does not cover this", so the failure mode is a ticket rather than an
invented policy. `escalation accuracy` is a gated metric in CI, at 100%.

**Evaluation gates the pipeline.** Three metrics with floors, run on every pull
request:

- `retrieval recall@5` — did the correct source document appear in the top 5?
- `answer accuracy` — an LLM judge scores each answer against a per-question rubric.
- `escalation accuracy` — did the agent escalate exactly when it should have?

**Embeddings are pluggable.** With `VOYAGE_API_KEY` set, the service uses
`voyage-3`. Without it, it falls back to a deterministic local hashed-bigram
embedder. The fallback is not as good, but it makes ingestion, retrieval, and CI
runnable with zero external dependencies.
