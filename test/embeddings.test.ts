import assert from "node:assert/strict";
import { test } from "node:test";
import { embedLocally } from "../src/embeddings.ts";
import { config } from "../src/config.ts";

function cosine(a: number[], b: number[]): number {
  return a.reduce((total, value, index) => total + value * b[index]!, 0);
}

test("embeds to the configured dimension", () => {
  const vector = embedLocally("night shift premium");

  assert.equal(vector.length, config.embeddingDimensions);
});

test("is deterministic", () => {
  const first = embedLocally("carry over leave");
  const second = embedLocally("carry over leave");

  assert.deepEqual(first, second);
});

test("hashes a word and its trigrams into fixed buckets", () => {
  const vector = embedLocally("leave");
  const buckets = vector.flatMap((value, index) => (value === 0 ? [] : [[index, value]]));

  // Stored vectors were hashed this way, so a change here needs a new LOCAL_MODEL name.
  assert.deepEqual(buckets, [
    [146, 0.5],
    [483, 0.5],
    [663, 0.5],
    [809, 0.5],
  ]);
});

test("returns unit vectors, so cosine is a dot product", () => {
  const vector = embedLocally("parental leave notice");

  assert.ok(Math.abs(cosine(vector, vector) - 1) < 1e-9);
});

test("ranks related text above unrelated text", () => {
  const query = embedLocally("how many leave days carry over");
  const related = embedLocally("unused leave days carry over");
  const unrelated = embedLocally("night shift premium");

  assert.ok(cosine(query, related) > cosine(query, unrelated));
});
