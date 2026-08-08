import type { AgentResult, Meta } from "../types";

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? response.statusText);
  }
  return body as T;
}

export function fetchMeta(): Promise<Meta> {
  return json<Meta>("/meta");
}

export function askQuestion(question: string): Promise<AgentResult> {
  return json<AgentResult>("/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
}
