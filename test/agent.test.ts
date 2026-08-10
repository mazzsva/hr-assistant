import assert from "node:assert/strict";
import { test } from "node:test";
import { headcountFilters, tools, systemPrompt } from "../src/agent.ts";

test("counts everyone when no filter is given", () => {
  assert.deepEqual(headcountFilters({}), { where: "", values: [] });
});

test("numbers placeholders in filter order", () => {
  const { where, values } = headcountFilters({
    department: "Engineering",
    level: "Lead",
  });

  assert.equal(where, "WHERE department = $1 AND level = $2");
  assert.deepEqual(values, ["Engineering", "Lead"]);
});

test("ignores an unknown field", () => {
  const { where, values } = headcountFilters({ salary: "100000" });

  assert.equal(where, "");
  assert.deepEqual(values, []);
});

test("never puts a value into the SQL string", () => {
  const { where, values } = headcountFilters({ location: "Berlin'; DROP TABLE employees--" });

  assert.equal(where, "WHERE location = $1");
  assert.deepEqual(values, ["Berlin'; DROP TABLE employees--"]);
});

test("exposes exactly the three tools the prompt relies on", () => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["search_policies", "headcount_query", "escalate_to_hr"],
  );
  for (const tool of tools) {
    assert.match(systemPrompt, new RegExp(tool.name));
  }
});
