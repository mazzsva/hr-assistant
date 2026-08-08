import styles from "./MetaRow.module.css";

/** A left identifier and a right measurement. Used by the trace and retrieval. */
export function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}
