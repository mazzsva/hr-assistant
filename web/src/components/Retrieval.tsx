import type { Passage } from "../types";
import { Panel } from "./ui/Panel";
import { CodeBlock } from "./ui/CodeBlock";
import { MetaRow } from "./ui/MetaRow";
import { similarity } from "../lib/format";
import styles from "./Retrieval.module.css";

export function Retrieval({ passages }: { passages: Passage[] }) {
  if (passages.length === 0) {
    return (
      <Panel title="Retrieval">
        <p className={styles.empty}>No handbook passages were retrieved.</p>
      </Panel>
    );
  }

  const ranked = [...passages].sort((a, b) => b.similarity - a.similarity);

  return (
    <Panel
      title="Retrieval"
      hint="Cosine similarity to the closest of the model's search queries."
    >
      {ranked.map((passage) => (
        <article key={passage.chunkId} className={styles.item}>
          <MetaRow
            label={`[${passage.chunkId}] ${passage.source}`}
            value={similarity(passage.similarity)}
          />
          <div className={styles.bar}>
            <div
              className={styles.fill}
              style={{ width: `${Math.max(0, passage.similarity) * 100}%` }}
            />
          </div>
          <CodeBlock>{passage.content}</CodeBlock>
        </article>
      ))}
    </Panel>
  );
}
