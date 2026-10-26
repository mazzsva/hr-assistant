import assert from "node:assert/strict";
import { test } from "node:test";
import { checkItems, loadCalibration } from "../evals/calibrate.ts";

test("labels every calibration answer by its kind for a grounded case", async () => {
  const { cases, items } = await loadCalibration();
  assert.deepEqual(checkItems(items, cases), []);
});

test("rejects a mutant labelled pass", async () => {
  const { cases } = await loadCalibration();
  const problems = checkItems(
    [{ caseId: "sick-note-day", kind: "wrong-number", label: "pass", answer: "" }],
    cases,
  );
  assert.deepEqual(problems, ["item 1 (sick-note-day, wrong-number): label must be fail"]);
});
