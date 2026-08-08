import styles from "./Answer.module.css";

interface Props {
  answer: string;
  escalated: boolean;
}

export function Answer({ answer, escalated }: Props) {
  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <span className={styles.label}>Answer</span>
        {escalated && <span className={styles.badge}>escalated</span>}
      </div>
      <p className={styles.body}>{answer}</p>
    </section>
  );
}
