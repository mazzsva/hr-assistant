import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMarkdown } from "../src/chunk.ts";

test("splits on headings", () => {
  const chunks = chunkMarkdown("# Policy\n\n## One\n\nFirst.\n\n## Two\n\nSecond.");

  assert.deepEqual(chunks, ["## One\n\nFirst.", "## Two\n\nSecond."]);
});

test("drops a heading-only section", () => {
  const chunks = chunkMarkdown("# Title\n\n## Real\n\nBody.");

  assert.deepEqual(chunks, ["## Real\n\nBody."]);
});

test("keeps the heading on every part of a long section", () => {
  const paragraph = "word ".repeat(200).trim();
  const chunks = chunkMarkdown(`## Overtime\n\n${paragraph}\n\n${paragraph}`);

  assert.deepEqual(chunks, [`## Overtime\n\n${paragraph}`, `## Overtime\n\n${paragraph}`]);
});

test("never splits inside a paragraph, even one over the limit", () => {
  const paragraph = "word ".repeat(400).trim();
  const chunks = chunkMarkdown(`## Overtime\n\n${paragraph}`);

  assert.deepEqual(chunks, [`## Overtime\n\n${paragraph}`]);
});

test("returns nothing for an empty document", () => {
  assert.deepEqual(chunkMarkdown(""), []);
});
