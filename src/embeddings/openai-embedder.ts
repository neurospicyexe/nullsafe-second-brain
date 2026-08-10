import type { Embedder } from "./embedder.js";

interface OpenAIEmbedderOptions {
  model: string;
  apiKey: string;
}

/**
 * Embedder health, observable from OUTSIDE the embedder (2026-08-10).
 *
 * The OpenAI credit balance hit zero on 2026-07-31 and nothing noticed for nine days: every consumer either
 * degraded quietly (search fell back to lexical, by design) or dropped the write (Discord ingest 500s). The
 * failure was in the logs the whole time and in no alarm anywhere.
 *
 * There is no usable OpenAI balance endpoint to poll, so this does not mirror the DeepSeek balance check --
 * the signal is the embedder's OWN last outcome. Per [fail-open-hides-a-dead-mechanism], it records the
 * REASON, not just a count: `credit_balance_exhausted` is a standing outage that needs a human and money,
 * and is alertable on the FIRST occurrence, while a transient 429 or a timeout only matters if it persists.
 */
export type EmbedderFailureKind = "quota" | "auth" | "rate_limit" | "transient" | null;

export interface EmbedderHealth {
  ok: boolean;
  /** Coarse cause, so an alert can distinguish "add money" from "retry later". */
  failure_kind: EmbedderFailureKind;
  consecutive_failures: number;
  last_error: string | null;
  last_error_at: string | null;
  last_success_at: string | null;
}

const health: EmbedderHealth = {
  ok: true,
  failure_kind: null,
  consecutive_failures: 0,
  last_error: null,
  last_error_at: null,
  last_success_at: null,
};

export function getEmbedderHealth(): EmbedderHealth {
  return { ...health };
}

/** Classify by the provider's own error code, not by HTTP status: a 429 is a quota wall or a speed bump. */
export function classifyEmbedderError(message: string): Exclude<EmbedderFailureKind, null> {
  if (/insufficient_quota|credit_balance_exhausted|no credits remaining|billing/i.test(message)) return "quota";
  if (/\b401\b|invalid_api_key|incorrect api key|unauthoriz/i.test(message)) return "auth";
  if (/\b429\b|rate.?limit/i.test(message)) return "rate_limit";
  return "transient";
}

function noteSuccess(): void {
  health.ok = true;
  health.failure_kind = null;
  health.consecutive_failures = 0;
  health.last_success_at = new Date().toISOString();
}

function noteFailure(message: string): void {
  health.ok = false;
  health.failure_kind = classifyEmbedderError(message);
  health.consecutive_failures += 1;
  health.last_error = message.slice(0, 300);
  health.last_error_at = new Date().toISOString();
}

export class OpenAIEmbedder implements Embedder {
  constructor(private options: OpenAIEmbedderOptions) {}

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: texts, model: this.options.model }),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = `OpenAI embeddings fetch failed: ${(err as Error).message}`;
      noteFailure(msg);
      throw new Error(msg);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      const msg = `OpenAI embeddings error: ${response.status} ${response.statusText} — ${body}`;
      noteFailure(msg);
      throw new Error(msg);
    }
    const json = await response.json() as { data: { embedding: number[] }[] };
    noteSuccess();
    return json.data.map(d => d.embedding);
  }
}
