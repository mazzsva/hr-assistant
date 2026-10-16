import type { ReactNode } from "react";
import styles from "./Panel.module.css";

interface Props {
  title: string;
  hint?: string;
  children: ReactNode;
}

export function Panel({ title, hint, children }: Props) {
  return (
    <section className={styles.panel}>
      <header className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {hint && <p className={styles.hint}>{hint}</p>}
      </header>
      {children}
    </section>
  );
}
