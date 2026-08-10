export interface Prices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// List prices per million tokens. A model without an entry stops the boot,
// so the trace can never report a cost from the wrong price list.
const PRICES: Record<string, Prices> = {
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const model = process.env.MODEL ?? "claude-opus-5";
const prices = PRICES[model];

if (!prices) {
  throw new Error(
    `No prices for MODEL=${model}. Add them to PRICES in src/config.ts.`,
  );
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://hr:hr@localhost:5432/hr",
  port: Number(process.env.PORT ?? 3000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  model,
  prices,
  embeddingDimensions: 1024,
  retrievalTopK: 5,
};

export function requireAnthropicKey(): string {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return config.anthropicApiKey;
}
