import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMarkdown } from "../src/chunk.ts";

test("splits on headings", () => {
  const chunks = chunkMarkdown("# Policy\n\n## One\n\nFirst.\n\n## Two\n\nSecond.");

  assert.equal(chunks.length, 2);
  assert.match(chunks[0]!, /## One/);
  assert.match(chunks[1]!, /## Two/);
});

test("drops a heading-only section", () => {
  const chunks = chunkMarkdown("# Title\n\n## Real\n\nBody.");

  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!, /## Real/);
});

test("keeps the heading on every split of a long section", () => {
  const paragraph = "word ".repeat(200).trim();
  const chunks = chunkMarkdown(`## Overtime\n\n${paragraph}\n\n${paragraph}`);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.match(chunk, /^## Overtime/);
  }
});

test("returns nothing for an empty document", () => {
  assert.deepEqual(chunkMarkdown(""), []);
});
