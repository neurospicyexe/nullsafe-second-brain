import type { EmbedderHealth } from "./embeddings/openai-embedder.js";
import type { CronJobHealth } from "./ingestion/cron-health.js";

export interface HealthInputs {
  crons: CronJobHealth[];
  cronsHealthy: boolean;
  embedder: EmbedderHealth;
  pendingEmbed: number;
  pendingEmbedOldestAgeHours: number | null;
  pendingIndex: number;
  /** Vault writes the adapter accepted but has not delivered (ObsidianRestAdapter queue). 0 for adapters without a queue. */
  vaultQueuePending: number;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  service: "nullsafe-second-brain";
  timestamp: string;
  crons: CronJobHealth[];
  embedder: EmbedderHealth & {
    pending_embed: number;
    pending_embed_oldest_age_hours: number | null;
    pending_index: number;
  };
  vault_queue_pending: number;
}

/**
 * Pure builder for the /health body so it can be tested without booting index-http.ts (which
 * calls createServer() at import). `status` doubles as the HTTP code: ok = 200, degraded = 503.
 */
export function buildHealthPayload(i: HealthInputs, now: Date = new Date()): HealthPayload {
  // The embedder is a PAID remote dependency whose death is silent by design (search degrades to lexical,
  // ingest queues). Silent is right for availability and wrong for operations -- so it is reported here, with
  // its reason, plus the depth and age of the write queue it strands. See openai-embedder.getEmbedderHealth.
  const embedderOk = i.embedder.ok || i.embedder.failure_kind === "transient";
  const healthy = i.cronsHealthy && embedderOk;
  return {
    status: healthy ? "ok" : "degraded",
    service: "nullsafe-second-brain",
    timestamp: now.toISOString(),
    crons: i.crons,
    embedder: {
      ...i.embedder,
      // Queue depth is the SECOND-ORDER alarm: if the embedder recovers but this keeps climbing, the drain
      // is broken rather than the provider, and those are different problems with different fixes.
      pending_embed: i.pendingEmbed,
      pending_embed_oldest_age_hours: i.pendingEmbedOldestAgeHours,
      pending_index: i.pendingIndex,
    },
    // Undelivered vault writes. A queued write is NOT a written one (vault-materializer counts them apart);
    // this is the operator's view of the same number. Climbing here with a healthy embedder = Obsidian or
    // its tunnel is down on the Windows side, not this service.
    vault_queue_pending: i.vaultQueuePending,
  };
}
