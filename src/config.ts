export interface Prices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// List prices in USD per million tokens, only for models that accept adaptive thinking and effort.
const PRICES: Record<string, Prices> = {
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

// An empty line in .env sets "", so || falls back where ?? would not.
const model = process.env.MODEL || "claude-opus-5";
const prices = PRICES[model];

// An unknown model fails at boot, not on the first /ask.
if (!prices) {
  throw new Error(
    `No prices for MODEL=${model}. Add them to PRICES in src/config.ts.`,
  );
}

const dailyBudgetUsd = process.env.DAILY_BUDGET_USD
  ? Number(process.env.DAILY_BUDGET_USD)
  : undefined;

if (dailyBudgetUsd !== undefined && !(dailyBudgetUsd >= 0)) {
  throw new Error(
    `DAILY_BUDGET_USD=${process.env.DAILY_BUDGET_USD} is not an amount in US dollars.`,
  );
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgres://hr:hr@localhost:5432/hr",
  port: Number(process.env.PORT || 3000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  model,
  prices,
  dailyBudgetUsd,
  embeddingDimensions: 1024,
  retrievalTopK: 5,
};

export function requireAnthropicKey(): string {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return config.anthropicApiKey;
}
