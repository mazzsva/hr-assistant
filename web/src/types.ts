export interface Passage {
  chunkId: number;
  source: string;
  title: string;
  content: string;
  similarity: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export type TraceStep =
  | {
      kind: "model";
      turn: number;
      ms: number;
      usage: Usage;
      stopReason: string | null;
      text: string;
      requested: { name: string; input: unknown }[];
    }
  | {
      kind: "tool";
      turn: number;
      ms: number;
      name: string;
      input: unknown;
      summary: string;
      passageIds: number[];
    };

export interface AgentResult {
  answer: string;
  passages: Passage[];
  escalated: boolean;
  turns: number;
  latencyMs: number;
  usage: Usage;
  trace: TraceStep[];
}

export interface Meta {
  model: string;
  embedder: string;
  embeddingDimensions: number;
  retrievalTopK: number;
  systemPrompt: string;
  tools: { name: string; description: string; input_schema: unknown }[];
  corpus: {
    documents: number;
    chunks: number;
    employees: number;
    answered: number;
  };
}
