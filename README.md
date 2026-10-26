# HR Assistant

HR policy agent in TypeScript, Claude, and Postgres.

An employee asks an HR question in plain language. A Claude agent searches the
policy handbook, counts employees with SQL when the question is about headcount,
and either answers with citations or opens a ticket for a person in HR.

The handbook in `docs/` and the employee rows are made up. They describe a
generic European manufacturer, not a real company. The leave and working-time
rules follow German law.

## Technologies

<table>
  <tr><td><b>Language</b></td><td>TypeScript</td></tr>
  <tr><td><b>Server</b></td><td>Node 22 and Express 5</td></tr>
  <tr><td><b>Model</b></td><td>Claude, <code>claude-opus-5</code> by default</td></tr>
  <tr><td><b>Database</b></td><td>PostgreSQL 17 with <code>pgvector</code></td></tr>
  <tr><td><b>Embeddings</b></td><td>A local hashing embedder, or Voyage <code>voyage-3</code> with a key</td></tr>
  <tr><td><b>Interface</b></td><td>React 19 with Vite</td></tr>
  <tr><td><b>Deployment</b></td><td>Docker and Kubernetes</td></tr>
</table>

## Tests and evals

The eval has 12 development cases and 14 held-out cases. The eval exits 1 when a
metric falls below its floor. [ARCHITECTURE.md](ARCHITECTURE.md#evaluation)
explains each metric and its limits.

| Metric | Floor | Development, 12 cases | Held-out, 14 cases |
| --- | --- | --- | --- |
| Retrieval recall@5 (section level) | 0.85 | 1.000 (9/9) | 0.667 (6/9) |
| Answer accuracy, 3 runs of each case | 0.80 | 1.000 (36/36) | 1.000 (42/42) |
| Cases that passed all 3 runs | | 12/12 | 14/14 |
| Escalation accuracy | 1.00 | 1.000 (36/36) | 1.000 (42/42) |
| Escalation recall, runs of the cases that must escalate | | 1.000 (6/6, 2 cases) | 1.000 (12/12, 4 cases) |

These results are from 27 October 2026 with `claude-opus-5` and the local
embedder. The 3 runs of a case are not independent samples, so the run counts
overstate the evidence. The prompt was tuned on the development cases. The
held-out cases were committed before their first run, and the agent's prompt has
not changed since. The held-out set fails the retrieval floor, and the results
show it as it is. A random top 5 of the 14 chunks would score about 0.36 on
retrieval. The median answer took 5.5 s on both sets. The agent calls cost
$0.017 a question on the development set and $0.020 on the held-out set.

The first held-out run scored 40/42 on answers. Both failures were one
escalation case in which the judge, without handbook text, took a true detail
for an invented one. The judge now gets the retrieved passages for escalation
cases too, and the table shows the run after that fix.
[ARCHITECTURE.md](ARCHITECTURE.md#what-the-evals-do-not-tell-me) has the details.

The judge agreed with 36 of 36 answers in a calibration set, 25 of them with one
error put in on purpose. That set covers only grounded answers on the
development cases, and it is small. `npm run calibrate` runs that check.

The unit tests cover chunking, the local embedder, the headcount filter builder,
and the agent loop against a stub client.

```sh
npm test                                # unit tests, no database and no API key
npm run eval                            # scores evals/dataset.json, exits 1 below a floor
EVAL_DATASET=heldout.json npm run eval  # scores the held-out set
EVAL_REPEATS=3 npm run eval             # runs each answer case 3 times
npm run calibrate                       # scores the judge against labelled answers
```

Without `ANTHROPIC_API_KEY` the eval scores retrieval only. It needs Postgres,
and it costs nothing with the local embedder. When `.env` has a key, clear the
keys in the shell. Node does not let `.env` override a variable that is already
set, even an empty one:

```sh
ANTHROPIC_API_KEY= VOYAGE_API_KEY= npm run eval
```

A full run prints the cost of the agent calls and the prompt cache tokens they
read and wrote. The judge calls are not in that total.

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

Design reasoning and known limits are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Run locally

### Configuration

All settings are environment variables. `.env.example` lists all of them except
`API_URL`.

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Needed to answer. Ingest and the retrieval eval run without it |
| `VOYAGE_API_KEY` | none | Uses `voyage-3` when set, a local embedder when not |
| `MODEL` | `claude-opus-5` | Must accept adaptive thinking and an effort setting. Without prices in `src/config.ts` the server does not start |
| `DAILY_BUDGET_USD` | none | When the answers of the last 24 hours cost this much, `POST /ask` returns 429 and does not call the model |
| `DATABASE_URL` | `postgres://hr:hr@localhost:5432/hr` | |
| `PORT` | `3000` | |
| `API_URL` | `http://localhost:3000` | Vite dev proxy target. Set it in the shell for `npm run web:dev`, because Vite does not read the root `.env` |

Each document records the embedding model it was ingested with. When you set or
remove `VOYAGE_API_KEY`, the next boot re-embeds the handbook. The vector column
is `VECTOR(1024)`, so a model with a different dimension needs a new database.

### With Docker

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

### On macOS

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

Ask a question:

```sh
curl -s localhost:3000/ask -H 'content-type: application/json' \
  -d '{"question":"How many leave days can I carry over?"}'
```

## API

| Endpoint | Returns |
| --- | --- |
| `POST /ask` | Answer, outcome, passages, token usage and cost, trace |
| `GET /healthz` | Chunk count, embedder, model |
| `GET /meta` | The live system prompt, tool schemas and corpus counts |
| `GET /stats` | For the last 24 hours: question count, escalation rate, failure rate, p50 and p95 latency, mean cost |

## Deploy

The `ci` workflow runs typecheck, tests, the web build and the retrieval eval on
every push to `main` and on every pull request. It uses no secrets. On `main` it
then pushes `ghcr.io/mazzsva/hr-assistant` with a `latest` tag and a
`sha-<short commit>` tag.

The `eval` workflow runs the answer eval on the development set once. It calls
the model and costs money, and it reports a regression without blocking the
image. It runs by hand, or on a push to `main` that changes `src/`, `docs/`,
`evals/` or the package files. Pull requests never start it, and two runs never overlap.
It reads `ANTHROPIC_API_KEY`, and `VOYAGE_API_KEY` if set, from the `eval`
environment, and fails when the Anthropic key is missing.

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
