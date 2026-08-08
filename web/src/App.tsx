import { useEffect, useState } from "react";
import type { AgentResult, Meta } from "./types";
import { askQuestion, fetchMeta } from "./lib/api";
import { Header } from "./components/Header";
import { AskForm } from "./components/AskForm";
import { Answer } from "./components/Answer";
import { Metrics } from "./components/Metrics";
import { Trace } from "./components/Trace";
import { Retrieval } from "./components/Retrieval";
import { Config } from "./components/Config";
import styles from "./App.module.css";

export function App() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => undefined);
  }, []);

  async function submit() {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await askQuestion(trimmed));
      setMeta(await fetchMeta());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className={styles.main}>
      <div className={styles.top}>
        <Header meta={meta} />
        <AskForm
          question={question}
          pending={pending}
          onChange={setQuestion}
          onSubmit={submit}
        />
      </div>

      {pending && <p className={styles.status}>Retrieving and reasoning…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {result && (
        <>
          <Answer answer={result.answer} escalated={result.escalated} />
          <Metrics result={result} />
          <Trace trace={result.trace} />
          <Retrieval passages={result.passages} />
        </>
      )}

      {meta && <Config meta={meta} />}
    </main>
  );
}
