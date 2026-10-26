# Architecture

This file explains why the system is built the way it is, and where it is weak.
`README.md` explains how to run it.

## The problem

"How many leave days can I carry over?" needs a correct answer with a citation.
"What is my performance rating?" needs a person, because the answer is in a
personal record and not in the handbook.

An HR assistant has to tell these two apart. A wrong answer about leave or pay
costs the employee more than a slow answer from a person. The goal is to answer
the questions the handbook answers, correctly and with a source, and to send
every other question to a person instead of guessing.

## Request path

```
question
   │
   ▼
agent loop ──── search_policies ───► pgvector cosine top 5 ──► passages
   │       ├─── headcount_query ───► SQL over employees ─────► a count
   │       └─── escalate_to_hr ────► ticket and reply
   ▼
answer with [chunk id] citations ──► answers table ──► GET /stats
```

The loop is `ask()` in `src/agent.ts`. Each turn calls the model with adaptive
thinking at medium effort, runs the tools it requests at the same time, and
sends the results back in request order as the next user message. The loop ends
in one of four outcomes: `answered`, `escalated`, `refused` (the response
stopped with `stop_reason: "refusal"`) or `incomplete` (the model hit
`max_tokens`, gave an empty reply, or used all six turns). The server records a
fifth, `error`, when `ask()` throws.

Effort is medium, not the model's default of high, to keep latency and cost down
on short questions over a small handbook. The eval has not compared the two.

## Source layout

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

## Decisions

### Retrieval is a tool the model calls

The usual pipeline embeds the question, retrieves, puts the passages into the
prompt and answers. A question with two parts then gets one blended query, which
often retrieves only one of the parts. A question that is not about policy, such
as a headcount or a personal record, still gets five passages, and the model can
build an answer from the closest one.

With retrieval as a tool, the model can send one narrow query for each part of a
question, and none when the question is about a count or a person. The tool
description asks for this and the trace shows what the model did, but no eval
case measures it. The cost is one more model round trip on most questions.

The tool design does not help with a policy question that the handbook does not
answer, such as a sabbatical of over a year. The agent searches and gets five
near misses, as the pipeline would. For those questions the defense is the
prompt rule to escalate when the passages do not answer, and the
`escalate_to_hr` tool. The `not-in-handbook` eval case tests this.

Retrieval has no similarity cutoff. On the local embedder a correct top passage
can score below a wrong one. `sick-note-day` ranks the right section first at a
cosine similarity of 0.110, because the question says "doctor's note" and the
handbook says "medical certificate". `remote-abroad` ranks a wrong section first
at 0.211. Any cutoff low enough to keep the correct passage at 0.110 also keeps
the wrong one at 0.211. Voyage scores on its own scale, which I have not
measured on this corpus. The model decides whether the passages answer the
question.

### Headcount is SQL

A count of people has one correct answer, and a vector search over prose cannot
give it. It always returns the nearest paragraph, which the model then has to
ignore. `headcount_query` has enum inputs for department, location and level.
All three tools are strict, so the API guarantees that each input matches its
schema, and the model cannot send a value such as "Sales" that would silently
count 0 rows. `headcountFilters` builds the `WHERE`
clause from a fixed column list, and every value goes in as a `$n` placeholder.
A unit test checks that no value gets into the SQL string.

The same applies to other facts with one correct answer, such as leave balances,
shift rosters and reporting lines. In a real deployment they would be tools over
the system of record, not documents.

### Escalation is a tool

`escalate_to_hr` lets the model say that the handbook does not cover a question.
Without it the model can only answer or refuse, and with near-miss passages in
context it is pulled toward answering.

The first version of `escalate_to_hr` returned only a ticket number. Asked about
a sabbatical policy that does not exist, the agent replied with that number and
nothing else. The employee could not tell whether they had asked the wrong
question or whether no policy exists. A rule in the system prompt alone did not
fix it, so the tool now requires a `coverage` input: one sentence, written to
the employee, on what the handbook does and does not say. The tool builds the
reply from that sentence and the ticket number, and the model is told to send
it back as is.

Strict mode guarantees that `coverage` is present but not that it has text,
because a single space passes the schema. So `runTool` checks for text, and a
unit test sends a single space. An empty value throws, so the model gets an
`is_error` result and can call the tool again. When the model rewrites the reply
and drops the ticket number, the loop appends the tool's reply to the answer.
When the model cannot finish after a ticket is open, the employee still gets the
ticket reply. Tests in `test/agent.test.ts` cover each of these paths with a
stub client.

The ticket is a stub: its number is `HR-` and a base-36 timestamp. The reply,
with the ticket number, is stored in `answers`. The `reason` input is not
stored: it appears only in the trace that `/ask` returns.

### Chunks follow headings

`chunkMarkdown` splits on `#`, `##` and `###` headings and drops a section that
has only a heading. A section longer than 1200 characters is packed into parts
on paragraph boundaries, and every part repeats the heading. A passage that
says "10 days carry over, take them by 31 March" is easier to check when it
starts with `## Annual leave`. The passage tag sent to the model also names the
source file. A single paragraph longer than the limit stays whole, so the limit
is soft.

On this corpus the split path never runs. The three documents make 14 chunks,
and the longest is 629 characters. Unit tests cover the split.

### Two embedders: Voyage or local

With `VOYAGE_API_KEY`, the embedder is `voyage-3`, which returns
1024-dimensional vectors. Without it, a local embedder hashes each word and its
character trigrams into 1024 signed buckets (`embedLocally` in
`src/embeddings.ts`). The local embedder is lexical: it matches shared words and
word fragments, not meaning. It lets ingest, retrieval and the tests run with no
external service, and the retrieval gate in CI runs the same way in forks.
Another Voyage model that returns 1024 dimensions needs only a change to the
`VOYAGE_MODEL` constant in `src/embeddings.ts`, and the next boot re-embeds the
handbook.

Every result in this repository so far uses the local embedder. The Voyage path
has not run against this corpus yet.

Every document row records the embedding model and a hash of its title and
chunks. Retrieval ranks only chunks from the active model. Without this, setting
`VOYAGE_API_KEY` on an existing database would compare Voyage query vectors with
local document vectors, and retrieval would return unrelated chunks with no
error.

### The server syncs the handbook on every boot

`docs/` is copied into the image, so a new image can carry a changed policy. On
every boot the server runs `migrate()` and then `ingestAll()`. Ingest re-embeds
a document only when its hash or embedding model changed, and deletes the
documents whose file is gone, so a removed policy can no longer be cited.

Both steps take a Postgres advisory lock inside their transaction, because the
two replicas in `deploy/k8s.yaml` boot at the same time. Without the lock, two
concurrent `CREATE EXTENSION` statements can fail, and the employee seed can
run twice. The usual alternative is a Kubernetes Job that migrates before the
rollout. For two replicas and one schema the lock is simpler; a Job is better
once other services share the database or a migration takes minutes.

The `CREATE TABLE` statements describe a new database. A database from the first
version gets the later columns from two `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` statements. Its documents get an empty `content_hash`, so the next boot
re-embeds them once, and its old answers keep a null `outcome`, which `/stats`
skips. A change that `ADD COLUMN` cannot express, such as a new `CHECK`, needs a
migration tool with a version table.

When a document changes, its chunks get new ids. An old `chunk_ids` value in
`answers` then matches no row, so it can never point to text that has changed.

### Prompt caching

The request puts `cache_control` on the system prompt, which caches the tools
and the system prompt together as one prefix of 1,196 tokens. That is above the
minimum for both priced models: 512 tokens for `claude-opus-5` and 1,024 for
`claude-sonnet-5`. In the eval run of 25 October 2026, the 12 questions took 26
model turns. The first turn wrote the prefix to the cache, and the other 25 read
it, 29,900 tokens in total. The trace shows `cacheReadTokens` for each turn.

The history that grows over the turns is not cached. Each turn resends the
earlier tool results, so a second breakpoint on the latest message is the next
change I would make to cut cost.

## Trade-offs

### No agent framework

`ask()` is about 130 lines against the Anthropic SDK. A framework, for example
the Vercel AI SDK in a TypeScript stack, would replace most of them and add
provider switching. It would also own the loop, which is where the per-turn
timings, token costs, tool inputs and outcome rules come from. With three tools
I would rather own it, and I would look at a framework again if a second
provider became a requirement.

### No streaming

Answers take a few seconds and arrive whole. Streaming would cut the time to the
first token, and it is the next UI change if answers get slower.

### No conversation memory

Each question stands alone, so "and if I'm part-time?" does not work. History is
easy to add, but the earlier topic can pull retrieval toward the wrong policy,
so a follow-up needs to be rewritten into a standalone query first.

### Seeded employee data

`migrate()` seeds 40 rows so that `headcount_query` has something to count.
Every location has every level, so no filter combination returns 0 by accident.
The seed runs only on an empty table, so a database seeded by an earlier version
keeps its rows until `employees` is truncated. A real deployment would query the
HR system of record.

## Evaluation

`npm run eval` runs `evals/run.ts` over the 12 cases in `evals/dataset.json`:
9 that the handbook answers, 2 that must be escalated, and 1 headcount question.
Each grounded case names its expected file and section. `EVAL_DATASET` selects
another file in `evals/`, and `EVAL_REPEATS` runs each answer case more than
once.

`evals/heldout.json` has 14 more cases: 9 grounded, 4 that must be escalated and
1 headcount question. They were generated with Claude from the handbook, checked
against it, and committed before their first run. The agent's prompt has not
been changed because of their results. They target what the development set
lacks: questions that share no
words with their section ("earlies to lates", "Elterngeld"), questions that need
two sections or two files, escalations close to a covered topic, and a prompt
injection.

| Metric | Floor | What it measures |
| --- | --- | --- |
| Retrieval recall@5 | 0.85 | Is the expected section in the top 5 for the question? |
| Answer accuracy | 0.80 | Do the code checks and the judge both pass? |
| Escalation accuracy | 1.00 | Did the agent escalate exactly when it should? |

The eval reports three metrics instead of one score, because a drop in answer
accuracy needs a different fix when retrieval missed the section than when the
model ignored it. Recall alone cannot tell those apart, because it scores the
raw question and not the agent's queries, which can retrieve better or worse.
The `reached=` column in the answer phase separates them, because it says
whether the expected section was in any passage the agent retrieved. Scoring the
raw question also means that recall needs no API key.

Retrieval is scored at section level. The first version scored at document
level, and with 3 documents and 5 of 14 chunks retrieved, a random retriever
would have found the right document about 92% of the time, above the floor. At
section level a random top 5 scores about 0.36. The gate uses recall@5 because
the model reads all five passages. The eval also prints recall@1, MRR and, for
each case, the rank of the expected section and the top passage with its cosine
similarity. Local embedder, 25 October 2026:

```
pass  carryover-deadline  rank=1 top=leave.md "## Annual leave" sim=0.443
pass  sick-note-day  rank=1 top=leave.md "## Sick leave" sim=0.110
pass  parental-notice  rank=1 top=leave.md "## Parental leave" sim=0.424
pass  night-and-sunday-premium  rank=1 top=working-time.md "## Shift premiums" sim=0.427
pass  overtime-payout  rank=1 top=working-time.md "## Overtime" sim=0.376
pass  remote-abroad  rank=3 top=leave.md "## Parental leave" sim=0.211
pass  referral-bonus-engineering  rank=1 top=hiring.md "## Referrals" sim=0.584
pass  referral-already-applied  rank=1 top=hiring.md "## Referrals" sim=0.438
pass  internal-move-timing  rank=1 top=hiring.md "## Internal applications" sim=0.282
recall@1 = 0.889 (8/9)
recall@5 = 1.000 (9/9)
MRR      = 0.926
```

In `remote-abroad`, "Can I work from Portugal for a few weeks?" ranks
`## Parental leave` above `## Remote work`, because "weeks" appears three times
in Parental leave and "Portugal" appears nowhere in the handbook.

Answer accuracy combines checks in code with a model judge. The code checks that
every `[id]` in the answer is a chunk the agent retrieved, that a grounded
answer cites at least one chunk, and that the headcount answer called
`headcount_query` and states the same number as the database. The judge cannot
check those, because it sees neither the passage ids nor the employees table.
The judge grades the answer against a rubric per case, such as "States seven
weeks' notice, and 13 weeks when the leave starts after the child's third
birthday." Each rubric names the exact facts the answer must contain, so the
judge checks specific facts instead of general quality.

For a grounded case the judge also gets the text of the expected section and of
the other passages the agent retrieved. It fails an answer that misses a rubric
clause, contradicts that text, or states a fact that the text does not support,
so an invented claim fails even when the rubric is covered. It writes its reason
before its verdict. For escalation and headcount cases it gets the passages the
agent retrieved, and judges claims about the handbook only from them.

`npm run calibrate` checks the judge against `evals/calibration.json`: 36
answers to the 9 grounded development cases, generated with Claude from the
handbook and committed before the first run. 11 are correct, 2 of them with
true detail from another section. 25 are copies of a correct answer with one
edit: a changed number, a changed condition, a missing rubric clause, or an
invented extra claim. The label follows from the kind of edit. On 27 October
2026 the judge agreed with all 36 labels. That is weak evidence: 25 edits of 9
base answers are not 25 independent samples, 0 false passes in 25 still allows
a false pass rate of about 12% (rule of three), and 0 false fails in 11 allows
about 27%. Each edit is one clear change made with the rubric in view, so it is
easier to catch than a real failure. The run was one sample of a judge that is
not deterministic. The calibration covers only the grounded prompt, not the
prompt for escalation and headcount cases.

Escalation accuracy is over all cases, so it is mostly the cases that must not
escalate. Escalation recall and the false escalation rate print as separate
lines. With `EVAL_REPEATS` above 1, the eval prints each case's passes out of
the runs, the cases that passed every run, and the cases that passed some runs
but not all. The gates use the pooled rate over all runs. The run also
prints the median latency and the total cost of the agent calls. When a request
fails after its retry, the case fails both answer accuracy and escalation
accuracy, the summary counts it as errored instead of missed or false, a case
that must escalate counts as a miss in escalation recall, and the run goes on
to the next case. A judge call that fails or stops early fails the
answer the same way.

The unit tests check chunking, the local embedder, the headcount filters and the
loop control flow. They do not run `search_policies` or `headcount_query`
against Postgres. When an answer case fails and the unit tests pass, the loop
control flow is not the cause. The trace shows whether it was the passages, the
prompt or the model.

## What the evals do not tell me

- The sets are small. Three runs of each case show which cases are unstable,
  but they do not make 12 cases into 36 independent samples. A perfect 12/12
  still has a 95% Wilson lower bound of about 0.76.
- The `eval` workflow runs the development set once, after the image is built,
  so it reports a regression but does not block a release. A 1.00 escalation
  floor on one sample of a stochastic agent will sometimes fail on noise alone,
  so a red run is a reason to rerun with `EVAL_REPEATS`, not proof of a
  regression.
- The prompt and the `coverage` input were changed after failures on the
  development cases, so those scores are optimistic. The held-out set is the
  better estimate, but it was generated from the handbook, so it is not a
  sample of real employee questions.
- On the held-out set, recall@5 on the raw question is 0.667 (6/9) with the
  local embedder, below the floor. Two misses share no key word with their
  section: "hand in my resignation" for `## Probation` and "earlies to lates"
  for `## Shift patterns`. The third, "late shift, then the early shift", ranks
  `## Shift patterns` first, which the answer also needs, but the case names
  only the rest period in `## Overtime`. The answers still passed, because the
  agent writes its own searches in the handbook's words. A semantic embedder
  such as `voyage-3` may close this gap, and this set is the place to measure
  it. No run has used Voyage yet.
- In the first held-out run, `parental-part-time` passed 1 of 3 runs. In the 2
  failed runs the agent escalated correctly and also mentioned the parental
  leave top-up, which the handbook does state. The rubric says the handbook
  "only refers to the statutory entitlement", and the judge then saw no
  handbook text for escalation cases, so it took the true detail for an
  invented one. The judge now gets the retrieved passages for these cases, and
  in the next run the case passed 3 of 3. That run does not show whether the
  fix or sampling made the difference, and the judge was changed after the
  held-out results, so the held-out answer score is less clean than its
  retrieval score. The rubric stays as it was committed.
- The judge is the same model as the agent, so it can prefer its own phrasing.
  The calibration set measures it only against answers with one clear error.
  Real answers that hedge or are partly right are not in it.
- Recall@5 of 1.000 on the development set is a weak bar, because the top 5 is
  over a third of the 14 chunks. Most development questions share a key word
  such as "overtime" with their section. The held-out result above shows what
  happens when they do not.
- No case has two documents with conflicting rules. The handbook has no
  superseded versions, so the eval cannot show that the agent prefers the
  current rule.

## Monitoring

`POST /ask` writes each question to `answers` with the answer, the retrieved
chunk ids, the outcome, the latency and the cost in USD. When a model request
fails, the row keeps the cost of the turns before the failure. The failed turn
returns no usage, so its cost is not counted. If the insert fails,
the server logs the error and still returns the answer. `GET /stats` reads the
last 24 hours of the table back as question count, escalation rate, failure
rate, p50 and p95 latency, and mean cost. An all-time average would hide a
sudden change, so the window is fixed at a day.

I watch the escalation rate most closely. A sudden fall can mean that the agent
has started to answer questions it used to send to a person, and neither latency
nor error rate shows that. A change in what employees ask also moves the rate,
so a fall is a reason to read the escalation cases in the eval and a sample of
recent answers, not proof of a regression. The rate counts only the `escalated`
outcome. Refusals, incomplete answers and errors go into the failure rate, so
failures do not raise the escalation rate.

Each response carries a per-turn trace with timings, token counts and cost,
priced from the table in `src/config.ts`. The UI shows it.

## Gaps that matter before real use

- `/ask` has no authentication and no rate limit. Each question can run six
  model turns. `DAILY_BUDGET_USD` stops new questions when the answers of the
  last 24 hours reach the budget. All replicas read the same `answers` table, so
  the cap is shared, but nothing reserves budget, so questions already running
  can go over it. A per-IP limit would be wrong here: each replica would count
  on its own, and behind a proxy or a factory network many employees share one
  address.
- Retrieved text goes into the model's context unfiltered. The handbook is
  trusted today. A corpus that employees can edit would make prompt injection a
  real path.
- A 500 response contains the raw error message. That is fine for an internal
  demo and not for production.
- Tickets are not sent anywhere, so an escalation today reaches no one.
- `answers` stores the question text. In HR the question itself can be personal
  data: a question about parental leave can disclose a pregnancy. Before real
  use it needs a retention period, restricted access and a notice to employees.

## Next

1. Hybrid retrieval. A dense embedder such as `voyage-3` can miss exact tokens
   such as a policy number or a euro amount. BM25 with rank fusion would catch
   them, and it matters more as the corpus grows.
2. Recency and authority in ranking. When two versions of a policy both
   retrieve, the superseded one should lose, but documents have no version or
   effective date today.
3. Access control in the retrieval query, not in the prompt. Real HR content is
   scoped by role and region. With an HNSW index, a `WHERE` filter is applied
   after the approximate search, so a narrow scope can return fewer than 5 rows.
   The `embedding_model` filter in `retrieve()` works the same way, and it is
   harmless today only because boot re-embeds every document to the active
   model. pgvector's iterative scans or a partial index per scope would fix it.
4. The document title in each chunk. The chunk text names its section but not
   its document, so "Leave and Absence Policy" does not contribute to the
   embedding. `retrieve()` already selects the title, but `renderPassages` does
   not put it in the passage tag, so the model does not see it either. The
   retrieval eval is free, but recall@5 is already 1.000, so only recall@1 and
   MRR can show a gain, and with 9 cases that gain would be one or two rank
   changes. It waits for more cases like `sick-note-day` and `remote-abroad`.
5. A groundedness signal in production. The eval's citation check, that every
   cited id was retrieved, needs no judge. Running it on every `/ask` and
   storing the result in `answers` would give production a quality signal
   besides the escalation rate.
6. Feedback into evals. A thumbs-down button in the UI, which does not exist
   yet, would save the question, the answer and the chunks as a candidate eval
   case.
7. A real ticket, written to the HR ticketing system with the reason and the
   coverage sentence.
