import type { FormEvent } from "react";
import { examples } from "../lib/examples";
import styles from "./AskForm.module.css";

interface Props {
  question: string;
  pending: boolean;
  onChange: (question: string) => void;
  onSubmit: () => void;
}

export function AskForm({ question, pending, onChange, onSubmit }: Props) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <input
          className={styles.input}
          value={question}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ask about leave, shifts, pay premiums, or referrals"
          aria-label="Question"
        />
        <button className={styles.submit} type="submit" disabled={pending}>
          {pending ? "Working" : "Ask"}
        </button>
      </form>

      <p className={styles.hint}>
        Each example exercises a different path through the agent.
      </p>
      <ul className={styles.examples}>
        {examples.map((example) => (
          <li key={example.question}>
            <button
              className={styles.example}
              type="button"
              onClick={() => onChange(example.question)}
            >
              <span className={styles.exampleLabel}>{example.label}</span>
              <span className={styles.exampleQuestion}>{example.question}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
