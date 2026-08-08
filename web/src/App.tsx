import { useEffect, useState, type FormEvent } from "react";
import type { AgentResult, Meta, Passage, TraceStep } from "./types";

const examples = [
  "How many leave days can I carry over?",
  "Do I get a premium for a night shift on a Sunday?",
  "What is the referral bonus for an engineering role?",
  "How many people work in Engineering?",
  "Am I underpaid compared to my colleague?",
];

export function App() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/meta")
      .then((response) => response.json())
      .then(setMeta)
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? response.statusText);
      setResult(body as AgentResult);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <header>
        <h1>HR Assistant</h1>
        <p>
          Answers come from the policy handbook only. Headcount comes from SQL.
          Anything else is routed to a human.
        </p>
        {meta && (
          <div className="chips">
            <span>{meta.model}</span>
            <span>{meta.corpus.chunks} chunks</span>
            <span>{meta.corpus.documents} documents</span>
            <span>top-k {meta.retrievalTopK}</span>
            <span>{meta.embedder} embedder</span>
            <span>{meta.corpus.answered} answered</span>
          </div>
        )}
      </header>

      <form onSubmit={submit}>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about leave, shifts, pay premiums, or referrals"
          aria-label="Question"
        />
        <button type="submit" disabled={pending}>
          {pending ? "Working…" : "Ask"}
        </button>
      </form>

      <ul className="examples">
        {examples.map((example) => (
          <li key={example}>
            <button type="button" onClick={() => setQuestion(example)}>
              {example}
            </button>
          </li>
        ))}
      </ul>

      {error && <p className="error">{error}</p>}
      {pending && <p className="working">Retrieving and reasoning…</p>}

      {result && <Result result={result} />}
      {meta && <AgentConfig meta={meta} />}
    </main>
  );
}

function Result({ result }: { result: AgentResult }) {
  return (
    <>
      <section className="answer-card">
        <div className="label">
          Answer
          {result.escalated && <span className="badge">escalated</span>}
        </div>
        <p className="answer">{result.answer}</p>
      </section>

      <section className="metrics">
        <Metric value={`${(result.latencyMs / 1000).toFixed(1)}s`} label="latency" />
        <Metric value={String(result.turns)} label="model turns" />
        <Metric
          value={result.trace.filter((step) => step.kind === "tool").length.toString()}
          label="tool calls"
        />
        <Metric
          value={result.usage.inputTokens.toLocaleString()}
          label="input tokens"
        />
        <Metric
          value={result.usage.outputTokens.toLocaleString()}
          label="output tokens"
        />
        <Metric
          value={result.usage.cacheReadTokens.toLocaleString()}
          label="cached tokens"
        />
        <Metric value={`$${result.usage.costUsd.toFixed(4)}`} label="cost" />
      </section>

      <Trace trace={result.trace} />
      <Retrieval passages={result.passages} />
    </>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Trace({ trace }: { trace: TraceStep[] }) {
  return (
    <section className="panel">
      <h2>Agent trace</h2>
      <p className="hint">
        Every model turn and every tool the model chose to call, in order.
      </p>
      <ol className="trace">
        {trace.map((step, index) => (
          <li key={index} className={step.kind}>
            <div className="row">
              <span className="tag">
                {step.kind === "model" ? `turn ${step.turn}` : step.name}
              </span>
              <span className="ms">{step.ms} ms</span>
            </div>

            {step.kind === "model" ? (
              <>
                <p className="detail">
                  {step.requested.length > 0
                    ? `Requested ${step.requested.map((call) => call.name).join(", ")}`
                    : `Produced the final answer (stop: ${step.stopReason})`}
                </p>
                {step.requested.map((call, callIndex) => (
                  <pre key={callIndex}>{JSON.stringify(call.input, null, 2)}</pre>
                ))}
                <p className="sub">
                  {step.usage.inputTokens.toLocaleString()} in ·{" "}
                  {step.usage.outputTokens.toLocaleString()} out ·{" "}
                  {step.usage.cacheReadTokens.toLocaleString()} cached · $
                  {step.usage.costUsd.toFixed(4)}
                </p>
              </>
            ) : (
              <>
                <p className="detail">{step.summary}</p>
                <pre>{JSON.stringify(step.input, null, 2)}</pre>
                {step.passageIds.length > 0 && (
                  <p className="sub">
                    returned chunks {step.passageIds.join(", ")}
                  </p>
                )}
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Retrieval({ passages }: { passages: Passage[] }) {
  if (passages.length === 0) {
    return (
      <section className="panel">
        <h2>Retrieval</h2>
        <p className="hint">
          Nothing was retrieved. The agent answered without searching the handbook.
        </p>
      </section>
    );
  }

  const max = Math.max(...passages.map((passage) => passage.similarity));

  return (
    <section className="panel">
      <h2>Retrieval</h2>
      <p className="hint">
        Cosine similarity against the question embedding, highest first.
      </p>
      {[...passages]
        .sort((a, b) => b.similarity - a.similarity)
        .map((passage) => (
          <article key={passage.chunkId}>
            <div className="row">
              <span className="tag">
                [{passage.chunkId}] {passage.source}
              </span>
              <span className="ms">{passage.similarity.toFixed(3)}</span>
            </div>
            <div className="bar">
              <div style={{ width: `${(passage.similarity / max) * 100}%` }} />
            </div>
            <pre>{passage.content}</pre>
          </article>
        ))}
    </section>
  );
}

function AgentConfig({ meta }: { meta: Meta }) {
  return (
    <section className="panel">
      <h2>Agent configuration</h2>
      <p className="hint">
        What the model is allowed to do. Served live from the running agent.
      </p>

      <details>
        <summary>System prompt</summary>
        <pre>{meta.systemPrompt}</pre>
      </details>

      {meta.tools.map((tool) => (
        <details key={tool.name}>
          <summary>
            <code>{tool.name}</code>
          </summary>
          <p className="detail">{tool.description}</p>
          <pre>{JSON.stringify(tool.input_schema, null, 2)}</pre>
        </details>
      ))}
    </section>
  );
}
