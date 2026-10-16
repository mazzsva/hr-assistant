import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ask, headcountFilters, tools, systemPrompt } from "../src/agent.ts";

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

interface Reply {
  stopReason: Anthropic.StopReason;
  content: unknown[];
}

// Repeats the last reply once the script runs out, so one tool call can drive the turn limit.
function stubClient(replies: Reply[]) {
  const requests: Anthropic.MessageParam[][] = [];
  const client = {
    messages: {
      create: async ({ messages }: { messages: Anthropic.MessageParam[] }) => {
        requests.push(structuredClone(messages));
        const reply = replies[Math.min(requests.length, replies.length) - 1]!;
        return {
          stop_reason: reply.stopReason,
          content: reply.content,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

function replyWithText(text: string): Reply {
  return { stopReason: "end_turn", content: [{ type: "text", text }] };
}

function replyWithToolCall(name: string, input: Record<string, string>): Reply {
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: `call-${name}`, name, input }],
  };
}

function readToolResult(request: Anthropic.MessageParam[]): Anthropic.ToolResultBlockParam {
  const content = request.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  return content[0]!;
}

test("answers with the model's text when no tool is requested", async () => {
  const { client } = stubClient([replyWithText("You get 30 days.")]);

  const result = await ask("How much leave do I get?", client);

  assert.equal(result.answer, "You get 30 days.");
  assert.equal(result.outcome, "answered");
  assert.equal(result.turns, 1);
});

const coverage = "The handbook does not cover individual salaries.";
// With Date mocked to 0, escalate_to_hr opens ticket HR-0.
const ticketReply =
  `${coverage} I have opened ticket HR-0 for a People partner, who will ` +
  `reply within two working days.`;

test("puts coverage before the ticket in the escalation reply", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { client, requests } = stubClient([
    replyWithToolCall("escalate_to_hr", { reason: "Individual pay question.", coverage }),
    replyWithText(ticketReply),
  ]);

  await ask("Why is my salary lower than my colleague's?", client);

  const content = String(readToolResult(requests[1]!).content);
  assert.equal(content.split("\n\n").at(-1), ticketReply);
});

test("keeps the model's reply when it gives the ticket number", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { client } = stubClient([
    replyWithToolCall("escalate_to_hr", { reason: "Pay question.", coverage }),
    replyWithText(ticketReply),
  ]);

  const result = await ask("Why is my salary lower?", client);

  assert.equal(result.answer, ticketReply);
  assert.equal(result.outcome, "escalated");
  assert.equal(result.escalated, true);
});

test("adds the escalation reply when the model drops the ticket number", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { client } = stubClient([
    replyWithToolCall("escalate_to_hr", { reason: "Pay question.", coverage }),
    replyWithText("I have opened a ticket for you."),
  ]);

  const result = await ask("Why is my salary lower?", client);

  assert.equal(result.answer, `I have opened a ticket for you.\n\n${ticketReply}`);
});

test("rejects an escalation without coverage so the model can retry", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { client, requests } = stubClient([
    replyWithToolCall("escalate_to_hr", { reason: "Pay question.", coverage: " " }),
    replyWithToolCall("escalate_to_hr", { reason: "Pay question.", coverage }),
    replyWithText(ticketReply),
  ]);

  const result = await ask("Why is my salary lower?", client);

  assert.equal(readToolResult(requests[1]!).is_error, true);
  assert.equal(result.outcome, "escalated");
});

test("stops after six turns without claiming an escalation", async () => {
  const { client, requests } = stubClient([replyWithToolCall("unknown_tool", {})]);

  const result = await ask("Loop forever.", client);

  assert.equal(requests.length, 6);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.escalated, false);
});

test("returns the open ticket when the turn limit follows an escalation", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { client } = stubClient([
    replyWithToolCall("escalate_to_hr", { reason: "Pay question.", coverage }),
  ]);

  const result = await ask("Why is my salary lower?", client);

  assert.equal(result.answer, ticketReply);
  assert.equal(result.outcome, "escalated");
});

test("returns the open ticket when the model ends without text", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { client } = stubClient([
    replyWithToolCall("escalate_to_hr", { reason: "Pay question.", coverage }),
    { stopReason: "end_turn", content: [] },
  ]);

  const result = await ask("Why is my salary lower?", client);

  assert.equal(result.answer, ticketReply);
  assert.equal(result.outcome, "escalated");
});

test("does not count an empty reply as answered", async () => {
  const { client } = stubClient([{ stopReason: "end_turn", content: [] }]);

  const result = await ask("How much leave do I get?", client);

  assert.equal(result.outcome, "incomplete");
  assert.notEqual(result.answer, "");
});

test("does not return a truncated answer", async () => {
  const { client } = stubClient([
    { stopReason: "max_tokens", content: [{ type: "text", text: "You get 3" }] },
  ]);

  const result = await ask("How much leave do I get?", client);

  assert.equal(result.outcome, "incomplete");
  assert.doesNotMatch(result.answer, /You get 3/);
});

test("reports a refusal as refused, not escalated", async () => {
  const { client } = stubClient([{ stopReason: "refusal", content: [] }]);

  const result = await ask("Something the model declines.", client);

  assert.equal(result.outcome, "refused");
  assert.equal(result.escalated, false);
});
