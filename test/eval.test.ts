import assert from "node:assert/strict";
import { test } from "node:test";
import { statesNumber } from "../evals/run.ts";

test("finds a number stated in the answer", () => {
  assert.equal(statesNumber("Engineering has 12 employees [3].", 12), true);
});

test("ignores a number inside a citation", () => {
  assert.equal(statesNumber("Engineering has 7 employees [12].", 12), false);
  assert.equal(statesNumber("Engineering has 7 employees [3, 12].", 12), false);
});

test("ignores a number inside a longer number", () => {
  assert.equal(statesNumber("Engineering has 120 employees.", 12), false);
});

test("ignores a number inside a larger amount", () => {
  assert.equal(statesNumber("Engineering has about 12,000 employees.", 12), false);
  assert.equal(statesNumber("Engineering has 12.5 positions.", 12), false);
});

test("finds a number at the end of a sentence", () => {
  assert.equal(statesNumber("Engineering has 12.", 12), true);
});
