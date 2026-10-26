import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AgentResult } from "../src/agent.ts";
import type { Passage } from "../src/retrieve.ts";
import { requireAnthropicKey } from "../src/config.ts";
import { judge, sectionText, type Case } from "./run.ts";

export interface CalibrationItem {
  caseId: string;
  kind: string;
  label: "pass" | "fail";
  answer: string;
  passages?: string[];
}

const KIND_LABELS: Record<string, "pass" | "fail"> = {
  correct: "pass",
  "correct-extra": "pass",
  "wrong-number": "fail",
  "wrong-condition": "fail",
  "missing-clause": "fail",
  "invented-claim": "fail",
};

export async function loadCalibration(): Promise<{ cases: Case[]; items: CalibrationItem[] }> {
  const cases = JSON.parse(
    await readFile(new URL("dataset.json", import.meta.url), "utf8"),
  ) as Case[];
  const items = JSON.parse(
    await readFile(new URL("calibration.json", import.meta.url), "utf8"),
  ) as CalibrationItem[];
  return { cases, items };
}

export function checkItems(items: CalibrationItem[], cases: Case[]): string[] {
  const grounded = new Set(
    cases.filter((testCase) => testCase.expectedSource).map((testCase) => testCase.id),
  );
  const problems: string[] = [];
  items.forEach((item, index) => {
    const name = `item ${index + 1} (${item.caseId}, ${item.kind})`;
    if (!grounded.has(item.caseId)) problems.push(`${name}: no grounded case with this id`);
    const label = KIND_LABELS[item.kind];
    if (!label) problems.push(`${name}: unknown kind`);
    else if (item.label !== label) problems.push(`${name}: label must be ${label}`);
    if (item.kind === "correct-extra" && !item.passages?.length) {
      problems.push(`${name}: needs the passages that support the extra detail`);
    }
  });
  return problems;
}

async function main(): Promise<void> {
  requireAnthropicKey();
  const { cases, items } = await loadCalibration();
  const problems = checkItems(items, cases);
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const sections = new Map<string, string>();
  const matrix = { truePass: 0, falsePass: 0, trueFail: 0, falseFail: 0 };
  const kinds = new Map<string, { agreed: number; total: number }>();

  console.log(`judge calibration: ${items.length} labelled answers`);
  for (const item of items) {
    const testCase = casesById.get(item.caseId)!;
    if (!sections.has(testCase.id)) sections.set(testCase.id, await sectionText(testCase));

    const passages: Passage[] = (item.passages ?? []).map((content, index) => ({
      chunkId: index + 1,
      source: "",
      title: "",
      content,
      similarity: 0,
    }));
    const result = { answer: item.answer, passages } as AgentResult;
    const verdict = await judge(testCase, result, sections.get(testCase.id)).catch(
      (error: Error) => ({
        passed: false,
        reason: `failed: ${error.message}`,
      }),
    );

    const labelPassed = item.label === "pass";
    const agreed = verdict.passed === labelPassed;
    if (labelPassed && verdict.passed) matrix.truePass++;
    if (!labelPassed && verdict.passed) matrix.falsePass++;
    if (!labelPassed && !verdict.passed) matrix.trueFail++;
    if (labelPassed && !verdict.passed) matrix.falseFail++;
    const kind = kinds.get(item.kind) ?? { agreed: 0, total: 0 };
    kinds.set(item.kind, { agreed: kind.agreed + (agreed ? 1 : 0), total: kind.total + 1 });

    console.log(
      `  judge=${verdict.passed ? "pass" : "FAIL"} label=${item.label}  ` +
        `${agreed ? "agree   " : "DISAGREE"}  ${item.caseId}  ${item.kind}`,
    );
    if (!agreed) console.log(`        judge: ${verdict.reason}`);
  }

  const agreed = matrix.truePass + matrix.trueFail;
  console.log(`\nconfusion matrix (n=${items.length})`);
  console.log(`                label=pass  label=fail`);
  console.log(
    `  judge=pass    ${String(matrix.truePass).padStart(10)}  ${String(matrix.falsePass).padStart(10)}`,
  );
  console.log(
    `  judge=fail    ${String(matrix.falseFail).padStart(10)}  ${String(matrix.trueFail).padStart(10)}`,
  );
  console.log(
    `  true pass ${matrix.truePass}, false pass ${matrix.falsePass}, ` +
      `true fail ${matrix.trueFail}, false fail ${matrix.falseFail}`,
  );
  console.log(
    `  agreement ${(agreed / items.length).toFixed(3)} (${agreed}/${items.length})\n`,
  );

  console.log("per kind");
  for (const [kind, { agreed, total }] of kinds) {
    const verb = KIND_LABELS[kind] === "pass" ? "passed" : "caught";
    console.log(`  ${kind.padEnd(16)}${verb} ${agreed}/${total}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
