# HR Assistant

An internal HR question-answering service. Employees ask a question in plain
language; an agent retrieves passages from the policy handbook, queries headcount
data with SQL, and either answers with citations or opens a ticket for a human HR
partner.

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

Retrieval recall runs with no API keys at all, so a fork or a Dependabot pull
request still gets a meaningful gate.

**Embeddings are pluggable.** With `VOYAGE_API_KEY` set, the service uses
`voyage-3`. Without it, it falls back to a deterministic local hashed-bigram
embedder. The fallback is not as good, but it makes ingestion, retrieval, and CI
runnable with zero external dependencies.

## Running it

```sh
cp .env.example .env          # add ANTHROPIC_API_KEY
docker compose up --build
```

Then open http://localhost:3000.

### Without Docker

Postgres 17 with the `vector` extension has to be reachable at `DATABASE_URL`.

```sh
npm install
npm ci --prefix web && npm run web:build
npm run ingest                # migrate + chunk + embed the handbook
npm run dev                   # API on :3000
```

`npm run web:dev` runs Vite on :5173 with `/ask` proxied to the API.

## Evaluating

```sh
npm run eval
```

The run re-ingests the handbook, scores every case in `evals/dataset.json`, and
exits non-zero when a metric drops below its floor. Add a case whenever a real
question is answered badly — the dataset is the regression suite.

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
  server.ts      HTTP API and static hosting
evals/
  dataset.json   Questions, rubrics, and expected escalation behavior
  run.ts         Metrics, thresholds, and the LLM judge
docs/            The policy handbook the assistant answers from
web/             React front end
```
