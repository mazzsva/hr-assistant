import styles from "./CodeBlock.module.css";

export function CodeBlock({ children }: { children: string }) {
  return <pre className={styles.code}>{children}</pre>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <CodeBlock>{JSON.stringify(value, null, 2)}</CodeBlock>;
}
