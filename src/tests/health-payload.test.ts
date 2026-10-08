import { describe, it, expect } from "vitest";
import { buildHealthPayload, type HealthInputs } from "../health-payload.js";

function inputs(over: Partial<HealthInputs> = {}): HealthInputs {
  return {
    crons: [],
    cronsHealthy: true,
    embedder: {
      ok: true,
      failure_kind: null,
      consecutive_failures: 0,
      last_error: null,
      last_error_at: null,
      last_success_at: "2026-10-08T00:00:00.000Z",
    } as HealthInputs["embedder"],
    pendingEmbed: 0,
    pendingEmbedOldestAgeHours: null,
    pendingIndex: 0,
    vaultQueuePending: 0,
    ...over,
  };
}

describe("buildHealthPayload", () => {
  it("exposes vault_queue_pending at the top level", () => {
    const body = buildHealthPayload(inputs({ vaultQueuePending: 7 }));
    expect(body.vault_queue_pending).toBe(7);
    expect(body.status).toBe("ok");
  });

  it("reports 0 for adapters without a write queue", () => {
    expect(buildHealthPayload(inputs()).vault_queue_pending).toBe(0);
  });

  it("a backed-up vault queue does not by itself flip status to degraded (it is an operator signal, not a liveness one)", () => {
    const body = buildHealthPayload(inputs({ vaultQueuePending: 500 }));
    expect(body.status).toBe("ok");
  });

  it("degraded when crons are unhealthy or the embedder has a non-transient failure", () => {
    expect(buildHealthPayload(inputs({ cronsHealthy: false })).status).toBe("degraded");
    const embedder = { ...inputs().embedder, ok: false, failure_kind: "auth" } as HealthInputs["embedder"];
    expect(buildHealthPayload(inputs({ embedder })).status).toBe("degraded");
    const transient = { ...inputs().embedder, ok: false, failure_kind: "transient" } as HealthInputs["embedder"];
    expect(buildHealthPayload(inputs({ embedder: transient })).status).toBe("ok");
  });

  it("keeps the embedder block shape the health check already depends on", () => {
    const body = buildHealthPayload(inputs({ pendingEmbed: 3, pendingIndex: 2, pendingEmbedOldestAgeHours: 1.5 }), new Date("2026-10-08T12:00:00Z"));
    expect(body.embedder.pending_embed).toBe(3);
    expect(body.embedder.pending_index).toBe(2);
    expect(body.embedder.pending_embed_oldest_age_hours).toBe(1.5);
    expect(body.timestamp).toBe("2026-10-08T12:00:00.000Z");
    expect(body.service).toBe("nullsafe-second-brain");
  });
});
