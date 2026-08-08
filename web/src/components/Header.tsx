import type { Meta } from "../types";
import styles from "./Header.module.css";

export function Header({ meta }: { meta: Meta | null }) {
  const chips = meta
    ? [
        meta.model,
        `${meta.corpus.documents} documents`,
        `${meta.corpus.chunks} chunks`,
        `top-k ${meta.retrievalTopK}`,
        `${meta.embedder} embedder`,
        `${meta.corpus.answered} answered`,
      ]
    : [];

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>HR Assistant</h1>
      <p className={styles.lede}>
        Answers come from the policy handbook only. Headcount comes from SQL.
        Anything else is routed to a human.
      </p>
      {chips.length > 0 && (
        <ul className={styles.chips}>
          {chips.map((chip) => (
            <li key={chip} className={styles.chip}>
              {chip}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
