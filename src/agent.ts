import Anthropic from "@anthropic-ai/sdk";
import { config, requireAnthropicKey } from "./config.ts";
import { pool } from "./db.ts";
import { retrieve, renderPassages, type Passage } from "./retrieve.ts";

const MAX_TURNS = 6;

const SYSTEM_PROMPT = `You answer HR policy questions for employees of a manufacturing company.

Answer only from the policy passages returned by search_policies, and from figures
returned by headcount_query. Never rely on general knowledge about employment law
or on what a policy "usually" says.

Cite the passage id for every policy claim, in the form [id]. If the retrieved
passages do not answer the question, say so plainly and call escalate_to_hr rather
than guessing. Questions about an individual's own pay, discipline, medical
situation, or a complaint about a person always go to escalate_to_hr.

When you escalate, never reply with only a ticket number. Say what the handbook
does and does not cover for this question, then give the ticket. An employee who
gets a bare ticket number cannot tell whether they asked the wrong question or
whether no policy exists.

Keep answers to a few sentences. Lead with the answer, then the condition or
exception that the employee has to act on.`;

export const systemPrompt = SYSTEM_PROMPT;

export const tools: Anthropic.Tool[] = [
  {
    name: "search_policies",
    description:
      "Search the company HR policy handbook and return the most relevant passages. " +
      "Call this before answering any question about leave, pay bands, shifts, " +
      "benefits, referrals, or any other written policy. Prefer several narrow " +
      "searches over one broad one when a question has multiple parts.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused natural-language search query.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "headcount_query",
    description:
      "Count current employees, optionally filtered by department, location, or " +
      "level. Use this for any question about how many people work somewhere. " +
      "Policy documents do not contain headcount figures.",
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
    },
  },
  {
    name: "escalate_to_hr",
    description:
      "Open a ticket for a human HR partner. Call this when the handbook does not " +
      "answer the question, or when the question concerns one individual's pay, " +
      "performance, health, or a complaint.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "One sentence on why a human has to take this.",
        },
      },
      required: ["reason"],
    },
  },
];

// Per-million-token list prices for the configured model, used to price a
// single question in the trace panel.
const PRICES = {
  input: 5,
  output: 25,
  cacheWrite: 6.25,
  cacheRead: 0.5,
} as const;

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

export interface AgentResult {
  answer: string;
  passages: Passage[];
  escalated: boolean;
  turns: number;
  latencyMs: number;
  usage: Usage;
  trace: TraceStep[];
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
      (inputTokens * PRICES.input +
        outputTokens * PRICES.output +
        cacheWriteTokens * PRICES.cacheWrite +
        cacheReadTokens * PRICES.cacheRead) /
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

export async function ask(question: string): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const startedAt = Date.now();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];
  const seen = new Map<number, Passage>();
  const trace: TraceStep[] = [];
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  let escalated = false;
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;
    const turnStartedAt = Date.now();
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
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

    if (response.stop_reason === "refusal") {
      return {
        answer: "This question could not be answered. Please contact HR directly.",
        passages: [...seen.values()],
        escalated: true,
        turns,
        latencyMs: Date.now() - startedAt,
        usage,
        trace,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) {
      return {
        answer: text,
        passages: [...seen.values()],
        escalated,
        turns,
        latencyMs: Date.now() - startedAt,
        usage,
        trace,
      };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const toolStartedAt = Date.now();
      try {
        const outcome = await runTool(toolUse);
        if (outcome.passages) {
          for (const passage of outcome.passages) seen.set(passage.chunkId, passage);
        }
        if (outcome.escalated) escalated = true;

        trace.push({
          kind: "tool",
          turn: turns,
          ms: Date.now() - toolStartedAt,
          name: toolUse.name,
          input: toolUse.input,
          summary: outcome.summary,
          passageIds: outcome.passages?.map((passage) => passage.chunkId) ?? [],
        });

        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: outcome.content,
        });
      } catch (error) {
        trace.push({
          kind: "tool",
          turn: turns,
          ms: Date.now() - toolStartedAt,
          name: toolUse.name,
          input: toolUse.input,
          summary: `failed: ${(error as Error).message}`,
          passageIds: [],
        });
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool failed: ${(error as Error).message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return {
    answer:
      "This question needed more steps than allowed. A human HR partner will follow up.",
    passages: [...seen.values()],
    escalated: true,
    turns,
    latencyMs: Date.now() - startedAt,
    usage,
    trace,
  };
}

interface ToolOutcome {
  content: string;
  summary: string;
  passages?: Passage[];
  escalated?: boolean;
}

async function runTool(toolUse: Anthropic.ToolUseBlock): Promise<ToolOutcome> {
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
      const filters: string[] = [];
      const values: string[] = [];
      for (const column of ["department", "location", "level"] as const) {
        const value = input[column];
        if (value) {
          values.push(value);
          filters.push(`${column} = $${values.length}`);
        }
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM employees ${where}`,
        values,
      );
      return {
        content: `count = ${rows[0]!.count}`,
        summary: `SQL returned ${rows[0]!.count}`,
      };
    }

    case "escalate_to_hr": {
      // The tool result is prompt too. Naming the shape of the reply here beats
      // the same instruction in the system prompt, because it arrives in the
      // turn where the model is deciding what to write.
      const ticket = `HR-${Date.now().toString(36).toUpperCase()}`;
      return {
        content:
          `Ticket ${ticket} opened. Now write the reply to the employee in this order: ` +
          `first one sentence on what the handbook does or does not say about their ` +
          `question, then the ticket number, then that a partner replies within two ` +
          `working days. A reply that is only a ticket number is not acceptable.`,
        summary: `ticket ${ticket}`,
        escalated: true,
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolUse.name}`);
  }
}
