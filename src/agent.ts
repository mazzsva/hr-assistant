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

Keep answers to a few sentences. Lead with the answer, then the condition or
exception that the employee has to act on.`;

const tools: Anthropic.Tool[] = [
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
        location: { type: "string", enum: ["Gruenheide", "Berlin", "Prague"] },
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

export interface AgentResult {
  answer: string;
  passages: Passage[];
  escalated: boolean;
  turns: number;
  latencyMs: number;
}

export async function ask(question: string): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const startedAt = Date.now();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];
  const seen = new Map<number, Passage>();
  let escalated = false;
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;
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

    if (response.stop_reason === "refusal") {
      return {
        answer: "This question could not be answered. Please contact HR directly.",
        passages: [...seen.values()],
        escalated: true,
        turns,
        latencyMs: Date.now() - startedAt,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const answer = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      return {
        answer,
        passages: [...seen.values()],
        escalated,
        turns,
        latencyMs: Date.now() - startedAt,
      };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      try {
        const outcome = await runTool(toolUse);
        if (outcome.passages) {
          for (const passage of outcome.passages) seen.set(passage.chunkId, passage);
        }
        if (outcome.escalated) escalated = true;
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: outcome.content,
        });
      } catch (error) {
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
  };
}

interface ToolOutcome {
  content: string;
  passages?: Passage[];
  escalated?: boolean;
}

async function runTool(toolUse: Anthropic.ToolUseBlock): Promise<ToolOutcome> {
  const input = toolUse.input as Record<string, string | undefined>;

  switch (toolUse.name) {
    case "search_policies": {
      const passages = await retrieve(input.query ?? "");
      if (passages.length === 0) {
        return { content: "No passages matched that query." };
      }
      return { content: renderPassages(passages), passages };
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
      return { content: `count = ${rows[0]!.count}` };
    }

    case "escalate_to_hr": {
      const ticket = `HR-${Date.now().toString(36).toUpperCase()}`;
      return {
        content: `Ticket ${ticket} opened. Tell the employee a partner will reply within two working days.`,
        escalated: true,
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolUse.name}`);
  }
}
