import { useState, type FormEvent } from "react";

interface Passage {
  chunkId: number;
  source: string;
  title: string;
  content: string;
  similarity: number;
}

interface AgentResult {
  answer: string;
  passages: Passage[];
  escalated: boolean;
  turns: number;
  latencyMs: number;
}

const examples = [
  "How many leave days can I carry over?",
  "Do I get a premium for a night shift on a Sunday?",
  "What is the referral bonus for an engineering role?",
];

export function App() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      <h1>HR Assistant</h1>
      <p className="lede">
        Answers come from the policy handbook only. Anything the handbook does not
        cover is routed to a human HR partner.
      </p>

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

      {result && (
        <section className="result">
          <p className="answer">{result.answer}</p>

          <p className="meta">
            {result.turns} turn{result.turns === 1 ? "" : "s"} ·{" "}
            {(result.latencyMs / 1000).toFixed(1)}s
            {result.escalated && " · escalated to HR"}
          </p>

          {result.passages.length > 0 && (
            <details>
              <summary>{result.passages.length} passages retrieved</summary>
              {result.passages.map((passage) => (
                <article key={passage.chunkId}>
                  <h3>
                    [{passage.chunkId}] {passage.title}
                    <span> · {passage.similarity.toFixed(3)}</span>
                  </h3>
                  <pre>{passage.content}</pre>
                </article>
              ))}
            </details>
          )}
        </section>
      )}
    </main>
  );
}
