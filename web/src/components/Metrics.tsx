import type { AgentResult } from "../types";
import { cost, duration, tokens } from "../lib/format";
import styles from "./Metrics.module.css";

export function Metrics({ result }: { result: AgentResult }) {
  const toolCalls = result.trace.filter((step) => step.kind === "tool").length;

  const cells = [
    { value: duration(result.latencyMs), label: "latency" },
    { value: String(result.turns), label: "model turns" },
    { value: String(toolCalls), label: "tool calls" },
    { value: tokens(result.usage.inputTokens), label: "input tokens" },
    { value: tokens(result.usage.outputTokens), label: "output tokens" },
    { value: tokens(result.usage.cacheReadTokens), label: "cached tokens" },
    { value: cost(result.usage.costUsd), label: "cost" },
  ];

  return (
    <div className={styles.grid}>
      {cells.map((cell) => (
        <div key={cell.label} className={styles.cell}>
          <span className={styles.value}>{cell.value}</span>
          <span className={styles.label}>{cell.label}</span>
        </div>
      ))}
    </div>
  );
}
