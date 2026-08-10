import { createHash } from "node:crypto";
import { config } from "./config.ts";

export type EmbeddingProvider = "voyage" | "local";

export function activeProvider(): EmbeddingProvider {
  return config.voyageApiKey ? "voyage" : "local";
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
      model: "voyage-3",
      input: texts,
      input_type: inputType,
      output_dimension: config.embeddingDimensions,
    }),
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

// Hashed bag-of-words, so CI and evals run without an embedding key.
function embedLocally(text: string): number[] {
  const vector = new Array<number>(config.embeddingDimensions).fill(0);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

  for (const token of tokens) {
    for (const gram of [token, ...bigrams(token)]) {
      const digest = createHash("sha1").update(gram).digest();
      const bucket = digest.readUInt32BE(0) % config.embeddingDimensions;
      const sign = (digest[4]! & 1) === 0 ? 1 : -1;
      vector[bucket] = vector[bucket]! + sign;
    }
  }

  return normalize(vector);
}

function bigrams(token: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i + 3 <= token.length; i++) {
    grams.push(token.slice(i, i + 3));
  }
  return grams;
}

function normalize(values: number[]): number[] {
  const magnitude = Math.hypot(...values);
  if (magnitude === 0) return values;
  return values.map((value) => value / magnitude);
}
