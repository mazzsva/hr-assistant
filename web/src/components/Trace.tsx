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

type ModelTurn = Extract<TraceStep, { kind: "model" }>;

// The checks run in the same order as the turn loop in src/agent.ts.
function describeTurn(step: ModelTurn): string {
  const names = step.requested.map((call) => call.name).join(", ");
  // The agent ends the run on these stops, before any requested tool runs.
  if (step.stopReason === "refusal" || step.stopReason === "max_tokens") {
    return names
      ? `Stopped: ${step.stopReason} while requesting ${names}`
      : `Stopped: ${step.stopReason}`;
  }
  if (names) return `Requested ${names}`;
  if (!step.text) return "Ended the turn without an answer";
  return "Wrote the final answer";
}

function ModelStep({ step }: { step: ModelTurn }) {
  return (
    <>
      <MetaRow label={`turn ${step.turn}`} value={duration(step.ms)} />
      <p className={styles.detail}>{describeTurn(step)}</p>
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
