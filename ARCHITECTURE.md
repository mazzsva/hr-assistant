# Architecture

Why it's built this way. `README.md` covers how to run it.

## The problem

"How many leave days can I carry over?" needs a correct answer with a citation.
"What's my performance rating?" needs a human — that lives in a personal record,
not the handbook.

A system that treats those the same is worse than no system. A confident wrong
answer about policy costs more than a slow one.

So the goal isn't answering more questions. It's **answering the answerable ones
accurately and routing the rest to a person without guessing.**

## Request path

```
question
   │
   ▼
agent loop ──── search_policies ───► pgvector cosine top-k ──► passages
   │       ├─── headcount_query ───► SQL over employees ────► a number
   │       └─── escalate_to_hr ────► ticket
   ▼
answer with [chunk id] citations   ──► answers table ──► /stats
```

Six turns max. Every answer is logged with its chunk ids and latency, so
production traffic becomes the source of new eval cases.

## Decisions

### Retrieval is a tool, not a pre-step

The obvious design — embed, retrieve, stuff into a prompt, answer — breaks two
ways. A multi-part question gets one blended query that retrieves neither part
well. A question with no policy answer still retrieves five irrelevant passages,
which is exactly the context that produces a confident invention.

As a tool, the agent issues several narrow searches when it needs them and none
when the question isn't about policy. Costs a round trip. Worth it.

### Headcount is SQL

Counting people is a query. A cosine search over prose will never answer it, but
it will always return *something* — the nearest paragraph, which the model then
has to ignore or misuse. A separate tool with an enum-constrained schema removes
the failure mode instead of prompting around it.

Generalises: **anything with a correct deterministic answer should be a query.**
Leave balances, shift rosters, org structure.

### Escalation is a first-class outcome

`escalate_to_hr` gives "I don't know" somewhere to go. Without it the model can
only answer or refuse — and under pressure from near-miss passages, it answers.

Escalating well is a second problem. Asked for a sabbatical policy that does not
exist, the first version replied with a ticket number and nothing else, which
leaves the employee unable to tell whether they asked the wrong question or
whether no policy exists. Instructions in the system prompt did not reliably fix
it. Making `coverage` a required tool input did: the model has to write the
sentence before it gets a ticket, and the tool hands back the finished reply.

The general lesson is worth more than the fix. **When a prompt keeps failing to
guarantee something, move it into a schema.** A required field is checked; an
instruction is only hoped for.

Gated at 100% in CI. It's the metric I'd show a skeptical HR director first,
because it measures the failure they actually care about.

### Chunking follows headings

Splits on markdown headings, and keeps the heading on every split of a long
section. A chunk saying "10 days carry over, take them by 31 March" without
naming its policy is a citation nobody can verify. Fixed-size chunking loses
that.

### Embeddings are pluggable

`voyage-3` when the key is set, a deterministic local hashed-bigram embedder when
it isn't. The fallback is worse on paraphrase but makes ingestion, retrieval, and
CI runnable with zero external dependencies.

Recall@5 is 1.000 with the fallback — the corpus is small and the questions share
vocabulary with the handbook. On hundreds of documents that drops and the hosted
embedder earns its keep.

## Evaluation

Three metrics, floors enforced on every pull request:

| Metric | Floor | Measures |
| --- | --- | --- |
| `retrieval recall@5` | 0.85 | Did the right document reach the model at all? |
| `answer accuracy` | 0.80 | Does the answer satisfy a per-question rubric, judged by a model? |
| `escalation accuracy` | 1.00 | Did it escalate exactly when it should have? |

Separate on purpose. When answer accuracy drops, recall tells me whether
retrieval stopped finding the document or the model stopped using it. Different
fixes. A single blended score hides which one I'm looking at.

Rubrics are specific — "states seven weeks' notice, and 13 weeks when the leave
starts after the child's third birthday" — not "is the answer good". A vague
rubric makes a judge that agrees with itself and tells you nothing.

Unit tests sit underneath and answer a different question. Evals tell me whether
the agent is right; `npm test` tells me whether chunking, the embedder, and the
headcount filters are right. When an eval fails, passing unit tests mean the
regression is in the agent, not in the plumbing.

## Monitoring

Every answer is written to `answers` with its chunk ids, escalation flag, and
latency. `GET /stats` reads that back as volume, escalation rate, and p50 and p95
latency.

Escalation rate is the number to watch. A sudden fall means the agent started
answering questions it used to route to a person, and that is the failure this
system exists to prevent — it will not show up in latency or error rates.

## Next

1. **Hybrid retrieval.** Cosine alone misses exact-token queries — a policy
   number, a euro amount. BM25 plus rank fusion is the highest-value change for a
   bigger corpus.
2. **Recency and authority in ranking.** Two versions of a policy both retrieve.
   The superseded one should lose. Nothing encodes that today.
3. **Feedback into evals.** A thumbs-down should create a candidate eval case
   with its chunks attached. The eval set has to grow from production or it
   decays into a fixed benchmark.
4. **Cost budgets.** Latency is already logged. Token cost per question is the
   missing half.
5. **Access control.** Everyone sees the same handbook. Real HR data is scoped by
   role and region, and that scoping belongs in the retrieval query, not the
   prompt.
6. **Retention for logged questions.** `answers` stores question text, and in an
   HR context that's among the most sensitive text in the company — someone
   asking about parental leave has disclosed something. Needs a retention window,
   restricted access, and a notice to employees before this runs for real.

## Trade-offs

**No agent framework.** The loop is about forty lines against the Anthropic SDK.
A framework — the Vercel AI SDK is the obvious one for a TypeScript stack — would
replace those lines and add provider switching. It would also own the loop, and
the loop is where the per-turn timings, token costs, and tool inputs in the trace
panel come from. At three tools that trade is not worth making. At thirty, or the
day a second provider matters, it is.

**No streaming.** Answers take a few seconds and arrive whole. That's a UX
improvement, not a correctness one.

**No conversation memory.** Each question is independent, so "and if I'm
part-time?" doesn't work. Adding history is easy. Adding it without letting stale
context leak into retrieval is the actual work.

**Seeded employee data.** 40 generated rows so `headcount_query` has something to
answer. Real deployment reads the HR system of record.
