import type { TraceStep } from "../types";
import { Panel } from "./ui/Panel";
import { JsonBlock } from "./ui/CodeBlock";
import { MetaRow } from "./ui/MetaRow";
import { cost, duration, tokens } from "../lib/format";
import styles from "./Trace.module.css";

export function Trace({ trace }: { trace: TraceStep[] }) {
  return (
    <Panel
      title="Agent trace"
      hint="Every model turn and every tool the model chose to call, in order."
    >
      <ol className={styles.list}>
        {trace.map((step, index) => (
          <li
            key={index}
            className={`${styles.step} ${step.kind === "tool" ? styles.tool : ""}`}
          >
            {step.kind === "model" ? (
              <ModelStep step={step} />
            ) : (
              <ToolStep step={step} />
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function ModelStep({ step }: { step: Extract<TraceStep, { kind: "model" }> }) {
  return (
    <>
      <MetaRow label={`turn ${step.turn}`} value={duration(step.ms)} />
      <p className={styles.detail}>
        {step.requested.length > 0
          ? `Requested ${step.requested.map((call) => call.name).join(", ")}`
          : `Wrote the final answer (stop: ${step.stopReason})`}
      </p>
      {step.requested.map((call, index) => (
        <JsonBlock key={index} value={call.input} />
      ))}
      <p className={styles.sub}>
        {tokens(step.usage.inputTokens)} in · {tokens(step.usage.outputTokens)} out
        · {tokens(step.usage.cacheReadTokens)} cached · {cost(step.usage.costUsd)}
      </p>
    </>
  );
}

function ToolStep({ step }: { step: Extract<TraceStep, { kind: "tool" }> }) {
  return (
    <>
      <MetaRow label={step.name} value={duration(step.ms)} />
      <p className={styles.detail}>{step.summary}</p>
      <JsonBlock value={step.input} />
      {step.passageIds.length > 0 && (
        <p className={styles.sub}>returned chunks {step.passageIds.join(", ")}</p>
      )}
    </>
  );
}
