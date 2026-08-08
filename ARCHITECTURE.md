# Architecture

Why this service is built the way it is. The README covers how to run it; this
covers the decisions and what I would change next.

## The problem

An employee asks "how many leave days can I carry over?" and needs a correct
answer with a citation. The same employee asks "what is my performance rating?"
and needs a human, because that answer lives in a personal record and not in the
handbook. A system that treats those two questions the same way is worse than no
system, because a confident wrong answer about policy costs more than a slow one.

So the design goal is not "answer more questions". It is **answer the answerable
ones accurately, and route the rest to a person without guessing.**

## Request path

```
question
   │
   ▼
agent loop ──── search_policies ───► pgvector cosine top-k ──► passages
   │       ├─── headcount_query ───► SQL over employees ────► a number
   │       └─── escalate_to_hr ────► ticket
   ▼
answer with [chunk id] citations   ──► answers table (question, chunks, latency)
```

The loop runs at most six turns. Every answer is written back to `answers` with
the chunk ids it used and its latency, so the production log is also the source
of new eval cases.

## Decisions

### Retrieval is a tool, not a pre-step

The obvious design is: embed the question, retrieve, stuff the passages into a
prompt, answer. It has two failure modes. A multi-part question ("what is the
referral bonus and when is it paid?") gets one blended query that retrieves
neither part well. A question with no policy answer still retrieves five
irrelevant passages, which is exactly the context that produces a confident
invention.

Making retrieval a tool lets the model issue several narrow searches for a
multi-part question, and issue none at all when the question is not about policy.
It costs a round trip. It is worth it.

### Headcount is SQL, not retrieval

Counting people is a query. A cosine search over prose will never answer it, but
it will always return *something* — the nearest paragraph, which the model then
has to either ignore or misuse. A separate tool with an enum-constrained schema
removes the failure mode instead of prompting around it.

This generalizes: **anything with a correct deterministic answer should be a
query, not a retrieval.** In a real deployment that would also cover leave
balances, shift rosters, and org structure.

### Escalation is a first-class outcome

`escalate_to_hr` exists so that "I don't know" has somewhere to go. Without it,
the model's only options are to answer or to refuse, and under pressure from a
retrieval that returned near-miss passages, it answers.

Escalation accuracy is gated at 100% in CI. It is the metric I would show a
skeptical HR director first, because it measures the failure they actually care
about.

### Chunking follows headings

`chunk.ts` splits on markdown headings and keeps the heading on every split of an
over-long section. A chunk that says "10 days carry over, take them by 31 March"
without saying which policy it belongs to is a citation the employee cannot
verify. Fixed-size character chunking loses that.

### Embeddings are pluggable

`voyage-3` when `VOYAGE_API_KEY` is set, and a deterministic local hashed-bigram
embedder when it is not. The fallback is genuinely worse on paraphrase, but it
makes ingestion, retrieval, and the CI eval run with zero external dependencies,
so a fork or a Dependabot pull request still gets a real retrieval gate.

Measured recall@5 on the eval set is 1.000 with the local fallback, because the
corpus is small and the questions share vocabulary with the handbook. On a real
handbook of hundreds of documents that number would fall and the hosted embedder
would carry its weight.

## Evaluation

Three metrics, floors enforced on every pull request:

| Metric | Floor | Measures |
| --- | --- | --- |
| `retrieval recall@5` | 0.85 | Did the correct source document reach the model at all? |
| `answer accuracy` | 0.80 | Does the answer satisfy a per-question rubric, judged by a model? |
| `escalation accuracy` | 1.00 | Did the agent escalate exactly when it should have? |

They are separate on purpose. When answer accuracy drops, recall tells me whether
the retrieval stopped finding the document or the model stopped using it. Those
have different fixes, and a single blended score hides which one I am looking at.

The rubrics are per-question and specific — "states seven weeks' notice, and 13
weeks when the leave starts after the child's third birthday" — not "is the
answer good". A vague rubric makes a judge that agrees with itself and tells you
nothing.

## What I would do next

1. **Hybrid retrieval.** Cosine similarity alone misses exact-token queries
   (a policy number, a euro amount). Adding BM25 and fusing the rankings is the
   highest-value change for a larger corpus.
2. **Recency and authority in ranking.** Two versions of a policy both retrieve;
   the superseded one should lose. Right now nothing encodes that.
3. **Answer-level feedback.** A thumbs-down on an answer should create a
   candidate eval case with its retrieved chunks attached. The eval set has to
   grow from production or it decays into a fixed benchmark.
4. **Per-question cost and latency budgets.** `answers` already records latency;
   token cost per question is the missing half of the operating picture.
5. **Access control.** Every employee currently sees the same handbook. Real HR
   data is scoped by role and region, and that scoping has to live in the
   retrieval query, not in the prompt.

## Trade-offs I accepted

- **No streaming.** Answers take a few seconds and arrive whole. Streaming is a
  UX improvement, not a correctness one, so it is not in the first version.
- **No conversation memory.** Each question is independent. Follow-ups
  ("and if I'm part-time?") do not work yet. Adding history is easy; adding it
  without letting stale context leak into retrieval is the actual work.
- **Seeded employee data.** `migrate.ts` generates 40 rows so `headcount_query`
  has something to answer. A real deployment reads from the HR system of record.
