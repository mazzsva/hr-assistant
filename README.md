# HR Assistant

An employee asks an HR question in plain language. A Claude agent searches the
policy handbook, counts employees with SQL when the question is about headcount,
and either answers with citations or opens a ticket for a person in HR.

The handbook in `docs/` and the employee rows are made up. They describe a
generic European manufacturer, not a real company. The leave and working-time
rules follow German law.

Design reasoning and known limits are in [ARCHITECTURE.md](ARCHITECTURE.md).

## How it works

The agent has three tools and decides which to call:

| Tool | What it does |
| --- | --- |
| `search_policies` | Cosine top 5 over handbook chunks in Postgres with `pgvector` |
| `headcount_query` | `SELECT count(*)` over `employees`, filtered by department, location or level |
| `escalate_to_hr` | Opens a ticket and returns a reply that says what the handbook covers |

Policy answers cite the chunks they used as `[id]`, and the eval checks that
every cited id was retrieved. The server stores each question in the `answers`
table with its outcome, latency and cost. The web UI shows the answer, the
per-turn trace with token cost, and the passages the agent retrieved.

Stack: Node 22, Express 5, TypeScript, PostgreSQL 17 with `pgvector`, React 19
with Vite. CI and deployment are under [Deploy](#deploy).

```
src/
  config.ts      Environment, model and prices
  db.ts          Pool and pgvector serialization
  migrate.ts     Schema and seed employees
  chunk.ts       Heading-aware markdown chunking
  embeddings.ts  Voyage, with a local feature-hashing fallback
  ingest.ts      Chunk, embed and sync docs/ into Postgres
  retrieve.ts    Cosine top-k
  agent.ts       Tools and the agent loop, ask()
  server.ts      API, ingest on every boot, static hosting
test/            Unit tests for the pure parts
evals/
  dataset.json   Questions, rubrics, expected escalation
  run.ts         Metrics, floors, model judge
docs/            The handbook
deploy/k8s.yaml  Deployment and Service
web/src/         React UI: App.tsx, components/, lib/ for API calls and formatting
```

## Run it with Docker

```sh
cp .env.example .env          # set ANTHROPIC_API_KEY
docker compose up --build
```

Open http://localhost:3000. On boot the server creates the schema, seeds 40
employees and ingests `docs/`. Compose passes only `ANTHROPIC_API_KEY` and
`VOYAGE_API_KEY` from `.env` into the container. Set other variables, such as
`MODEL`, in `docker-compose.yml`. Compose publishes Postgres on port 5432, so
stop a local Postgres first (`brew services stop postgresql@17`).

The schema has no migration history. `migrate()` adds the columns that were
added after the first version, so an older database keeps working. For any other
change to `src/migrate.ts`, run `docker compose down -v` to start again from an
empty database.

## Run it locally on macOS

You need Node 22.9 or later and Postgres 17 with `pgvector`.

```sh
brew install postgresql@17 pgvector
brew services start postgresql@17

# Apple Silicon path. On Intel Macs use /usr/local.
PSQL=/opt/homebrew/opt/postgresql@17/bin/psql

# SUPERUSER, so that migrate can run CREATE EXTENSION vector.
$PSQL -d postgres -c "CREATE ROLE hr LOGIN PASSWORD 'hr' SUPERUSER;"
$PSQL -d postgres -c "CREATE DATABASE hr OWNER hr;"

cp .env.example .env          # set ANTHROPIC_API_KEY
npm install
npm install --prefix web
npm run web:build             # the server hosts web/dist; without it / returns 404
npm run dev
```

Check that the handbook is loaded:

```sh
curl -s localhost:3000/healthz
# {"ok":true,"chunks":14,"embedder":"local","model":"claude-opus-5"}
```

The server syncs `docs/` on every boot and re-embeds only the documents that
changed. After you edit a policy, restart the server or run `npm run ingest`.

For front-end work, keep `npm run dev` running and start `npm run web:dev`. Vite
serves the UI on port 5173 with hot reload and sends API calls to port 3000.

Run every command from the repository root, because the server reads `docs/`
and `web/dist` from the working directory.

## Configuration

All settings are environment variables. `.env.example` lists all of them except
`API_URL`.

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Needed to answer. Ingest and the retrieval eval run without it |
| `VOYAGE_API_KEY` | none | Uses `voyage-3` when set, a local embedder when not |
| `MODEL` | `claude-opus-5` | Must accept adaptive thinking and an effort setting. Without prices in `src/config.ts` the server does not start |
| `DATABASE_URL` | `postgres://hr:hr@localhost:5432/hr` | |
| `PORT` | `3000` | |
| `API_URL` | `http://localhost:3000` | Vite dev proxy target. Set it in the shell for `npm run web:dev`, because Vite does not read the root `.env` |

Each document records the embedding model it was ingested with. When you set or
remove `VOYAGE_API_KEY`, the next boot re-embeds the handbook. The vector column
is `VECTOR(1024)`, so a model with a different dimension needs a new database.

## API

| Endpoint | Returns |
| --- | --- |
| `POST /ask` | Answer, outcome, passages, token usage and cost, trace |
| `GET /healthz` | Chunk count, embedder, model |
| `GET /meta` | The live system prompt, tool schemas and corpus counts |
| `GET /stats` | For the last 24 hours: question count, escalation rate, failure rate, p50 and p95 latency, mean cost |

```sh
curl -s localhost:3000/ask -H 'content-type: application/json' \
  -d '{"question":"How many leave days can I carry over?"}'
```

## Tests and evals

```sh
npm test        # unit tests, no database and no API key
npm run eval    # scores evals/dataset.json, exits 1 below a floor
```

The unit tests cover chunking, the local embedder, the headcount filter builder,
and the agent loop against a stub client.

The eval has 12 cases. [ARCHITECTURE.md](ARCHITECTURE.md#evaluation) explains
each metric and its limits.

| Metric | Floor | Last result |
| --- | --- | --- |
| Retrieval recall@5 (section level) | 0.85 | 1.000 (9/9) |
| Answer accuracy | 0.80 | 1.000 (12/12) |
| Escalation accuracy | 1.00 | 1.000 (12/12) |

These results are from 16 October 2026 with `claude-opus-5` and the local
embedder. A random top 5 of the 14 chunks would score about 0.36 on retrieval.
The median answer took 4.9 s and the agent calls cost $0.017 a question.

Without `ANTHROPIC_API_KEY` the eval scores retrieval only. It needs Postgres,
and it costs nothing with the local embedder. When `.env` has a key, clear the
keys in the shell. Node does not let `.env` override a variable that is already
set, even an empty one:

```sh
ANTHROPIC_API_KEY= VOYAGE_API_KEY= npm run eval
```

A full run prints the cost of the agent calls and the prompt cache tokens they
read and wrote. The judge calls are not in that total.

## Deploy

CI runs typecheck, tests, the web build and the eval on every push to `main`
and on every pull request. Forks have no keys, so they get the retrieval gate
only. On `main` it then pushes `ghcr.io/mazzsva/hr-assistant` with a `latest`
tag and a `sha-<short commit>` tag.

`deploy/k8s.yaml` runs two replicas behind a Service, with startup and readiness
probes on `/healthz`. It reads its settings from a Secret, and its image tag is
`sha-COMMIT`, which the deploy command replaces with a commit that CI built:

```sh
kubectl create secret generic hr-assistant \
  --from-literal=DATABASE_URL=... --from-literal=ANTHROPIC_API_KEY=...
sed "s/COMMIT/$(git rev-parse --short=7 HEAD)/" deploy/k8s.yaml | kubectl apply -f -
```

Each rollout names one immutable image, so `kubectl rollout undo
deployment/hr-assistant` returns to the previous commit.

The `DATABASE_URL` role must be able to run `CREATE EXTENSION vector`, or the
extension must already exist, because the server runs the migration on every
boot.
