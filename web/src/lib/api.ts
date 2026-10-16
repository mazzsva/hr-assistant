import type { AgentResult, Meta } from "../types";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    // A proxy error body is often not JSON, so fall back to the status line.
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function fetchMeta(): Promise<Meta> {
  return fetchJson<Meta>("/meta");
}

export function askQuestion(question: string): Promise<AgentResult> {
  return fetchJson<AgentResult>("/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
}
