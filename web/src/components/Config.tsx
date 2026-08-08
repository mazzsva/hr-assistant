import type { Meta } from "../types";
import { Panel } from "./ui/Panel";
import { CodeBlock, JsonBlock } from "./ui/CodeBlock";
import styles from "./Config.module.css";

export function Config({ meta }: { meta: Meta }) {
  return (
    <Panel
      title="Agent configuration"
      hint="What the model is allowed to do, served live from the running agent."
    >
      <details className={styles.item}>
        <summary className={styles.summary}>system prompt</summary>
        <CodeBlock>{meta.systemPrompt}</CodeBlock>
      </details>

      {meta.tools.map((tool) => (
        <details key={tool.name} className={styles.item}>
          <summary className={styles.summary}>{tool.name}</summary>
          <p className={styles.description}>{tool.description}</p>
          <JsonBlock value={tool.input_schema} />
        </details>
      ))}
    </Panel>
  );
}
