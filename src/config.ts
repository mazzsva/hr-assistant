export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://hr:hr@localhost:5432/hr",
  port: Number(process.env.PORT ?? 3000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  model: "claude-opus-5",
  embeddingDimensions: 1024,
  retrievalTopK: 5,
};

export function requireAnthropicKey(): string {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return config.anthropicApiKey;
}
