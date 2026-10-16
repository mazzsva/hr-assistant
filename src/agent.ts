import Anthropic from "@anthropic-ai/sdk";
import { config, requireAnthropicKey } from "./config.ts";
import { pool } from "./db.ts";
import { retrieve, renderPassages, type Passage } from "./retrieve.ts";

const MAX_TURNS = 6;
const REFUSED_ANSWER = "This question could not be answered. Please contact HR directly.";
const INCOMPLETE_ANSWER =
  "The assistant could not finish an answer to this question. Please contact HR directly.";

export const systemPrompt = `You answer HR policy questions for employees of a manufacturing company.

Answer only from the policy passages returned by search_policies, and from figures
returned by headcount_query. Never rely on general knowledge about employment law
or on what a policy "usually" says.

Cite the passage id for every policy claim, in the form [id]. If the retrieved
passages do not answer the question, say so plainly and call escalate_to_hr rather
than guessing. Questions about an individual's own pay, discipline, medical
situation, or a complaint about a person always go to escalate_to_hr.

When you escalate, send back the reply that escalate_to_hr hands you. It states
what the handbook covers before it gives the ticket, because an employee who gets
a bare ticket number cannot tell whether they asked the wrong question or whether
no policy exists.

Keep answers to a few sentences. Lead with the answer, then the condition or
exception that the employee has to act on.`;

export const tools: Anthropic.Tool[] = [
  {
    name: "search_policies",
    description:
      "Search the company HR policy handbook and return the most relevant passages. " +
      "Call this before answering any question about leave, pay bands, shifts, " +
      "benefits, referrals, or any other written policy. Prefer several narrow " +
      "searches over one broad one when a question has multiple parts.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused natural-language search query.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "headcount_query",
    description:
      "Count current employees, optionally filtered by department, location, or " +
      "level. Use this for any question about how many people work somewhere. " +
      "Policy documents do not contain headcount figures.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        department: {
          type: "string",
          enum: ["Production", "Engineering", "People", "Logistics"],
        },
        location: { type: "string", enum: ["Leipzig", "Berlin", "Prague"] },
        level: { type: "string", enum: ["Associate", "Senior", "Lead"] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_hr",
    description:
      "Open a ticket for a human HR partner. Call this when the handbook does not " +
      "answer the question, or when the question concerns one individual's pay, " +
      "performance, health, or a complaint.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "One sentence on why a human has to take this.",
        },
        coverage: {
          type: "string",
          description:
            "One sentence for the employee on what the handbook does and does not " +
            "say about their question. Written to them, not about them.",
        },
      },
      required: ["reason", "coverage"],
      additionalProperties: false,
    },
  },
];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export type TraceStep =
  | {
      kind: "model";
      turn: number;
      ms: number;
      usage: Usage;
      stopReason: string | null;
      text: string;
      requested: { name: string; input: unknown }[];
    }
  | {
      kind: "tool";
      turn: number;
      ms: number;
      name: string;
      input: unknown;
      summary: string;
      passageIds: number[];
    };

export type Outcome = "answered" | "escalated" | "refused" | "incomplete";

export interface AgentResult {
  answer: string;
  outcome: Outcome;
  passages: Passage[];
  escalated: boolean;
  turns: number;
  latencyMs: number;
  usage: Usage;
  trace: TraceStep[];
}

let sharedClient: Anthropic | undefined;

// Created on first use, so the server boots without ANTHROPIC_API_KEY.
export function anthropicClient(): Anthropic {
  sharedClient ??= new Anthropic({
    apiKey: requireAnthropicKey(),
    // Each attempt times out after a minute instead of the SDK default of ten.
    timeout: 60_000,
    maxRetries: 1,
  });
  return sharedClient;
}

function priceUsage(usage: Anthropic.Usage): Usage {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    costUsd:
      (inputTokens * config.prices.input +
        outputTokens * config.prices.output +
        cacheWriteTokens * config.prices.cacheWrite +
        cacheReadTokens * config.prices.cacheRead) /
      1_000_000,
  };
}

function addUsage(total: Usage, step: Usage): Usage {
  return {
    inputTokens: total.inputTokens + step.inputTokens,
    outputTokens: total.outputTokens + step.outputTokens,
    cacheWriteTokens: total.cacheWriteTokens + step.cacheWriteTokens,
    cacheReadTokens: total.cacheReadTokens + step.cacheReadTokens,
    costUsd: total.costUsd + step.costUsd,
  };
}

export async function ask(
  question: string,
  client = anthropicClient(),
): Promise<AgentResult> {
  const startedAt = Date.now();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const retrieved = new Map<number, Passage>();
  const trace: TraceStep[] = [];
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  let escalation: Escalation | undefined;
  let turns = 0;

  const finish = (answer: string, outcome: Outcome): AgentResult => ({
    answer,
    outcome,
    passages: [...retrieved.values()],
    escalated: outcome === "escalated",
    turns,
    latencyMs: Date.now() - startedAt,
    usage,
    trace,
  });

  // Once a ticket is open, the employee must see its number even if the model cannot finish.
  const giveUp = (answer: string, outcome: Outcome): AgentResult =>
    escalation ? finish(escalation.reply, "escalated") : finish(answer, outcome);

  while (turns < MAX_TURNS) {
    turns++;
    const turnStartedAt = Date.now();
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      tools,
      messages,
    });

    const turnUsage = priceUsage(response.usage);
    usage = addUsage(usage, turnUsage);

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    trace.push({
      kind: "model",
      turn: turns,
      ms: Date.now() - turnStartedAt,
      usage: turnUsage,
      stopReason: response.stop_reason,
      text,
      requested: toolUses.map((toolUse) => ({
        name: toolUse.name,
        input: toolUse.input,
      })),
    });

    if (response.stop_reason === "refusal") return giveUp(REFUSED_ANSWER, "refused");
    if (response.stop_reason === "max_tokens") return giveUp(INCOMPLETE_ANSWER, "incomplete");
    if (toolUses.length === 0) {
      if (!text) return giveUp(INCOMPLETE_ANSWER, "incomplete");
      if (!escalation) return finish(text, "answered");
      // The model sometimes rewords the escalation reply and drops the ticket number.
      const answer = text.includes(escalation.ticket) ? text : `${text}\n\n${escalation.reply}`;
      return finish(answer, "escalated");
    }

    // One turn can ask for several narrow searches, so they run at the same time.
    const calls = await Promise.all(
      toolUses.map(async (toolUse) => {
        const toolStartedAt = Date.now();
        const output = await runTool(toolUse).catch(
          (error: Error): ToolOutput => ({
            content: `Tool failed: ${error.message}`,
            summary: `failed: ${error.message}`,
            failed: true,
          }),
        );
        return { toolUse, output, ms: Date.now() - toolStartedAt };
      }),
    );

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const { toolUse, output, ms } of calls) {
      for (const passage of output.passages ?? []) {
        const known = retrieved.get(passage.chunkId);
        if (!known || passage.similarity > known.similarity) {
          retrieved.set(passage.chunkId, passage);
        }
      }
      escalation = output.escalation ?? escalation;

      trace.push({
        kind: "tool",
        turn: turns,
        ms,
        name: toolUse.name,
        input: toolUse.input,
        summary: output.summary,
        passageIds: output.passages?.map((passage) => passage.chunkId) ?? [],
      });
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output.content,
        is_error: output.failed,
      });
    }

    messages.push(
      { role: "assistant", content: response.content },
      { role: "user", content: results },
    );
  }

  return giveUp(INCOMPLETE_ANSWER, "incomplete");
}

// Column names come from this fixed list, never from the model.
export function headcountFilters(input: Record<string, string | undefined>): {
  where: string;
  values: string[];
} {
  const filters: string[] = [];
  const values: string[] = [];

  for (const column of ["department", "location", "level"] as const) {
    const value = input[column];
    if (value) {
      values.push(value);
      filters.push(`${column} = $${values.length}`);
    }
  }

  return { where: filters.length ? `WHERE ${filters.join(" AND ")}` : "", values };
}

export async function countEmployees(
  input: Record<string, string | undefined>,
): Promise<number> {
  const { where, values } = headcountFilters(input);
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM employees ${where}`,
    values,
  );
  return Number(rows[0]!.count);
}

interface Escalation {
  ticket: string;
  reply: string;
}

interface ToolOutput {
  content: string;
  summary: string;
  passages?: Passage[];
  escalation?: Escalation;
  failed?: boolean;
}

async function runTool(toolUse: Anthropic.ToolUseBlock): Promise<ToolOutput> {
  const input = toolUse.input as Record<string, string | undefined>;

  switch (toolUse.name) {
    case "search_policies": {
      const passages = await retrieve(input.query ?? "");
      if (passages.length === 0) {
        return { content: "No passages matched that query.", summary: "0 passages" };
      }
      const top = passages[0]!;
      return {
        content: renderPassages(passages),
        summary:
          `${passages.length} passages, top ${top.source} ` +
          `at ${top.similarity.toFixed(3)}`,
        passages,
      };
    }

    case "headcount_query": {
      const count = await countEmployees(input);
      return { content: `count = ${count}`, summary: `SQL returned ${count}` };
    }

    case "escalate_to_hr": {
      const coverage = input.coverage?.trim();
      // Strict mode guarantees that coverage is present, not that it has text.
      if (!coverage) {
        throw new Error("coverage is required: say what the handbook covers for this question");
      }
      const ticket = `HR-${Date.now().toString(36).toUpperCase()}`;
      const reply =
        `${coverage} I have opened ticket ${ticket} for a People partner, who will ` +
        `reply within two working days.`;
      return {
        content: `Ticket ${ticket} opened. Reply to the employee with exactly this:\n\n${reply}`,
        summary: `ticket ${ticket}`,
        escalation: { ticket, reply },
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolUse.name}`);
  }
}
