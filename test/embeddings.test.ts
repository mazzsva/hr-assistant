import assert from "node:assert/strict";
import { test } from "node:test";
import { embed } from "../src/embeddings.ts";
import { config } from "../src/config.ts";

function cosine(a: number[], b: number[]): number {
  return a.reduce((total, value, index) => total + value * b[index]!, 0);
}

test("embeds to the configured dimension", async () => {
  const [vector] = await embed(["night shift premium"], "document");

  assert.equal(vector!.length, config.embeddingDimensions);
});

test("is deterministic", async () => {
  const [first] = await embed(["carry over leave"], "query");
  const [second] = await embed(["carry over leave"], "query");

  assert.deepEqual(first, second);
});

test("returns unit vectors, so cosine is a dot product", async () => {
  const [vector] = await embed(["parental leave notice"], "document");

  assert.ok(Math.abs(cosine(vector!, vector!) - 1) < 1e-9);
});

test("ranks related text above unrelated text", async () => {
  const [query, related, unrelated] = await embed(
    ["how many leave days carry over", "unused leave days carry over", "night shift premium"],
    "document",
  );

  assert.ok(cosine(query!, related!) > cosine(query!, unrelated!));
});
