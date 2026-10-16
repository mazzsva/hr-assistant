import { createHash } from "node:crypto";
import { config } from "./config.ts";

export type EmbeddingProvider = "voyage" | "local";

// Returns 1024 dimensions, which must match config.embeddingDimensions.
const VOYAGE_MODEL = "voyage-3";
// Ingest re-embeds when this name changes, so bump it with any change to embedLocally.
const LOCAL_MODEL = "feature-hash-v1";

export function activeProvider(): EmbeddingProvider {
  return config.voyageApiKey ? "voyage" : "local";
}

export function activeEmbeddingModel(): string {
  return activeProvider() === "voyage" ? VOYAGE_MODEL : LOCAL_MODEL;
}

export async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  if (activeProvider() === "voyage") {
    return embedWithVoyage(texts, inputType);
  }
  return texts.map(embedLocally);
}

async function embedWithVoyage(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.voyageApiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: inputType,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Voyage returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as {
    data: { index: number; embedding: number[] }[];
  };
  return body.data
    .sort((a, b) => a.index - b.index)
    .map((entry) => normalize(entry.embedding));
}

// Signed feature hashing of words and character trigrams, so CI and evals run without a key.
export function embedLocally(text: string): number[] {
  const vector = new Array<number>(config.embeddingDimensions).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

  for (const word of words) {
    for (const feature of [word, ...characterTrigrams(word)]) {
      const digest = createHash("sha1").update(feature).digest();
      const bucket = digest.readUInt32BE(0) % config.embeddingDimensions;
      const sign = (digest[4]! & 1) === 0 ? 1 : -1;
      vector[bucket] = vector[bucket]! + sign;
    }
  }

  return normalize(vector);
}

function characterTrigrams(word: string): string[] {
  const trigrams: string[] = [];
  for (let i = 0; i + 3 <= word.length; i++) {
    trigrams.push(word.slice(i, i + 3));
  }
  return trigrams;
}

function normalize(values: number[]): number[] {
  const magnitude = Math.hypot(...values);
  if (magnitude === 0) return values;
  return values.map((value) => value / magnitude);
}
