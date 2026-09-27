// src/ingestion/evaluator.test.ts
import { describe, it, expect } from "vitest";
import { classifyDrift, computeBaseline, type DriftCalibration, type BaselineStats } from "./evaluator.js";

const CAL: DriftCalibration = {
  pressureZ: 2.5,
  growthZ: 1.2,
  minStd: 0.02,
  minMargin: 0.04,
  minSamples: 5,
  collapseCeiling: 0.90,
};

// A healthy, well-established baseline: scores cluster tightly around 0.61
// (this is what real embedding cosine distance looks like for on-identity voice).
const HEALTHY: BaselineStats = { mean: 0.61, std: 0.02, sampleCount: 20 };

describe("computeBaseline", () => {
  it("returns zeroed stats with no samples", () => {
    expect(computeBaseline([])).toEqual({ mean: 0, std: 0, sampleCount: 0 });
  });

  it("computes mean and population std", () => {
    const b = computeBaseline([0.60, 0.62, 0.61, 0.59, 0.63]);
    expect(b.sampleCount).toBe(5);
    expect(b.mean).toBeCloseTo(0.61, 5);
    expect(b.std).toBeGreaterThan(0);
    expect(b.std).toBeLessThan(0.02);
  });

  it("ignores non-finite values", () => {
    const b = computeBaseline([0.6, NaN, 0.62, Infinity, 0.61]);
    expect(b.sampleCount).toBe(3);
  });
});

describe("classifyDrift (calibrated)", () => {
  // THE REGRESSION: under the old absolute pressureAbsolute=0.50, a normal
  // ~0.61 reading was forced to "pressure" on every run. Calibrated, a reading
  // at the companion's own baseline is stable.
  it("classifies an at-baseline 0.61 reading as stable (regression: was forced pressure)", () => {
    expect(classifyDrift(0.61, HEALTHY, CAL)).toBe("stable");
  });

  it("classifies a below-baseline reading (more aligned than usual) as stable", () => {
    expect(classifyDrift(0.55, HEALTHY, CAL)).toBe("stable");
  });

  it("classifies a modest rise above own norm as growth", () => {
    // 0.66 vs mean 0.61, std floored to 0.02 -> z=2.5... that's pressure.
    // 0.64 -> margin 0.03, z=1.5 -> growth (z>=1.2, margin>=0.02).
    expect(classifyDrift(0.64, HEALTHY, CAL)).toBe("growth");
  });

  it("classifies a sharp rise well above own norm as pressure", () => {
    // 0.72 vs mean 0.61 -> margin 0.11, z=5.5 -> pressure.
    expect(classifyDrift(0.72, HEALTHY, CAL)).toBe("pressure");
  });

  it("flags pressure at collapse ceiling regardless of baseline", () => {
    expect(classifyDrift(0.95, HEALTHY, CAL)).toBe("pressure");
    // even with no baseline at all
    expect(classifyDrift(0.95, { mean: 0, std: 0, sampleCount: 0 }, CAL)).toBe("pressure");
  });

  it("refuses to flag on thin baseline (cold start) -> stable", () => {
    const thin: BaselineStats = { mean: 0.61, std: 0.02, sampleCount: 3 };
    expect(classifyDrift(0.80, thin, CAL)).toBe("stable");
  });

  it("does not trip on trivial wiggle when std is tiny (margin gate)", () => {
    // Very tight baseline; a 0.01 rise is z=... large, but margin 0.01 < minMargin/2.
    const tight: BaselineStats = { mean: 0.61, std: 0.001, sampleCount: 20 };
    expect(classifyDrift(0.62, tight, CAL)).toBe("stable");
  });

  it("uses minStd floor so near-zero variance cannot manufacture huge z", () => {
    // std 0 -> floored to minStd 0.02. 0.64 -> margin 0.03, z=1.5 -> growth not pressure.
    const flat: BaselineStats = { mean: 0.61, std: 0, sampleCount: 20 };
    expect(classifyDrift(0.64, flat, CAL)).toBe("growth");
  });
});

// ── Drift flag -> ledger lane (2026-09-26, imp-lane tranche 1) ──────────────
// The sustained-pressure flag used to be a second-person companion_journal row ("your own norm").
// It is now a drift-reader ledger line, third person, sourced to the basin_history row just written.
import { vi, afterEach } from "vitest";
import { runDriftEvaluation, buildDriftLedgerBody, driftDedupKey, DRIFT_RETRY_RULES } from "./evaluator.js";
import type { IngestionConfig } from "./types.js";
import type { OpenAIEmbedder } from "../embeddings/openai-embedder.js";

describe("buildDriftLedgerBody", () => {
  it("is a Recorded: line in third person, scores only, basin quoted", () => {
    const body = buildDriftLedgerBody({ companionId: "drevan", avgScore: 0.9512, baselineMean: 0.6, sampleCount: 12, worstBasin: "the house I hold" });
    expect(body).toBe(
      'Recorded: sustained pressure drift for Drevan across two consecutive evaluator runs. ' +
      'avg_distance=0.951 vs baseline_mean=0.600 (n=12). Worst drifted basin: "the house I hold".',
    );
    const unquoted = body.replace(/"[^"]*"/g, "");
    expect(unquoted).not.toMatch(/\b(you|your|I|me|my|we|our)\b/i);
    expect(body).not.toMatch(/Self-return|recommended/);
  });

  it("strips quotes and mark glyphs from the basin name; omits the clause when empty", () => {
    expect(buildDriftLedgerBody({ companionId: "gaia", avgScore: 1, baselineMean: 0.5, sampleCount: 5, worstBasin: '〔x〕 "y"' }))
      .toContain('Worst drifted basin: "x y".');
    expect(buildDriftLedgerBody({ companionId: "gaia", avgScore: 1, baselineMean: 0.5, sampleCount: 5, worstBasin: "" }))
      .not.toContain("basin:");
  });
});

describe("runDriftEvaluation -> ledger", () => {
  const CONFIG = { halsethUrl: "https://h.example", halsethSecret: "sek" } as IngestionConfig;
  const embedder = { embed: vi.fn(async () => [0, 1]) } as unknown as OpenAIEmbedder;
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function stubHalseth(ledgerStatus = 201, ledgerRoute?: (body: any, n: number) => Response) {
    let ledgerN = 0;
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (url.pathname === "/persona-blocks") return j({ blocks: [{ content: "voice" }] });
      if (url.pathname.startsWith("/companion-growth/basins/")) return j({ basins: [{ id: "b1", basin_name: "hearth", embedding: "[1,0]" }] });
      if (url.pathname.startsWith("/companion-growth/basin-history/") && init?.method !== "POST") {
        // previous evaluator run was pressure -> this run's pressure is SUSTAINED
        return j({ history: Array.from({ length: 6 }, () => ({ drift_score: 0.6, drift_type: "pressure", notes: "blocks_analyzed=1" })) });
      }
      if (url.pathname === "/companion-growth/basin-history") {
        const body = JSON.parse(String(init!.body));
        return j({ id: `bh-${body.companion_id}`, message: "ok" }, 201);
      }
      if (url.pathname === "/ledger") {
        if (ledgerRoute) return ledgerRoute(JSON.parse(String(init!.body)), ++ledgerN);
        return j({ id: "led_1", content: "x" }, ledgerStatus);
      }
      return j({ error: "unexpected" }, 500);
    }));
    return calls;
  }

  it("writes basin_history unchanged, then one drift-reader ledger line per companion sourced to that row; never the journal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const calls = stubHalseth();
    await runDriftEvaluation(CONFIG, embedder);
    const history = calls.filter(c => c.url.pathname === "/companion-growth/basin-history");
    expect(history).toHaveLength(3);
    expect(JSON.parse(String(history[0]!.init!.body))).toMatchObject({ drift_type: "pressure", worst_basin: "hearth" });
    const ledger = calls.filter(c => c.url.pathname === "/ledger").map(c => JSON.parse(String(c.init!.body)));
    expect(ledger).toHaveLength(3);
    const drevan = ledger.find(l => l.companion_id === "drevan");
    expect(drevan).toMatchObject({
      function: "drift-reader",
      source_kind: "row",
      source_ref: "companion_basin_history:bh-drevan",
    });
    expect(drevan.body).toMatch(/^Recorded: sustained pressure drift for Drevan /);
    expect(drevan.body).not.toMatch(/\byour?\b/i);
    expect(calls.some(c => c.url.pathname.includes("companion-journal"))).toBe(false);
  });

  it("a 404 or 422 from /ledger is logged and skipped -- no journal fallback", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [404, 422]) {
      const calls = stubHalseth(status);
      await runDriftEvaluation(CONFIG, embedder);
      expect(calls.some(c => c.url.pathname.includes("companion-journal"))).toBe(false);
    }
    expect(err.mock.calls.flat().join(" ")).toMatch(/404/);
    expect(err.mock.calls.flat().join(" ")).toMatch(/LEDGER REJECTED/);
  });
});

describe("drift-reader: one line per companion per day per basin (S3), one retry without the basin name (S1)", () => {
  const CONFIG = { halsethUrl: "https://h.example", halsethSecret: "sek" } as IngestionConfig;
  const embedder = { embed: vi.fn(async () => [0, 1]) } as unknown as OpenAIEmbedder;
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("driftDedupKey: drift:<companion>:<YYYY-MM-DD>:<basin slug>, capped at 200", () => {
    const d = new Date("2026-09-26T23:30:00.000Z");
    expect(driftDedupKey("drevan", "The House I Hold", d)).toBe("drift:drevan:2026-09-26:the-house-i-hold");
    expect(driftDedupKey("gaia", "", d)).toBe("drift:gaia:2026-09-26:none");
    expect(driftDedupKey("cypher", "x".repeat(400), d).length).toBe(200);
  });

  function stub(route: (body: any, n: number) => Response) {
    const ledger: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (url.pathname === "/persona-blocks") return j({ blocks: [{ content: "voice" }] });
      if (url.pathname.startsWith("/companion-growth/basins/")) return j({ basins: [{ id: "b1", basin_name: "vevi house", embedding: "[1,0]" }] });
      if (url.pathname.startsWith("/companion-growth/basin-history/") && init?.method !== "POST") {
        return j({ history: Array.from({ length: 6 }, () => ({ drift_score: 0.6, drift_type: "pressure", notes: "blocks_analyzed=1" })) });
      }
      if (url.pathname === "/companion-growth/basin-history") return j({ id: `bh-${JSON.parse(String(init!.body)).companion_id}` }, 201);
      if (url.pathname === "/ledger") { const b = JSON.parse(String(init!.body)); ledger.push(b); return route(b, ledger.length); }
      return j({ error: "unexpected" }, 500);
    }));
    return ledger;
  }

  it("the dedup key is per day + basin, not per basin_history row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ledger = stub(() => new Response(JSON.stringify({ id: "led_1", content: "x" }), { status: 201 }));
    await runDriftEvaluation(CONFIG, embedder);
    const day = new Date().toISOString().slice(0, 10);
    expect(ledger.find((l) => l.companion_id === "drevan").dedup_key).toBe(`drift:drevan:${day}:vevi-house`);
    expect(ledger.every((l) => !/bh-/.test(l.dedup_key))).toBe(true);
  });

  it.each([...DRIFT_RETRY_RULES])("a 422 %s retries ONCE without the basin clause and logs both", async (rule) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger = stub((b) => b.body.includes("Worst drifted basin")
      ? new Response(JSON.stringify({ error: "no", rule }), { status: 422 })
      : new Response(JSON.stringify({ id: "led_2", content: "x" }), { status: 201 }));
    await runDriftEvaluation(CONFIG, embedder);
    const drevan = ledger.filter((l) => l.companion_id === "drevan");
    expect(drevan).toHaveLength(2);
    expect(drevan[0].body).toContain('Worst drifted basin: "vevi house"');
    expect(drevan[1].body).not.toContain("basin:");
    expect(drevan[1].dedup_key).toBe(drevan[0].dedup_key);
    expect(err.mock.calls.flat().join(" ")).toMatch(new RegExp(`rule=${rule}.*retrying once without the basin clause`));
    expect(log.mock.calls.flat().join(" ")).toMatch(/retry without the basin clause: written/);
  });

  it("any other 422 rule is not retried; a retry that is refused again is not retried twice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const other = stub(() => new Response(JSON.stringify({ error: "no", rule: "verb" }), { status: 422 }));
    await runDriftEvaluation(CONFIG, embedder);
    expect(other.filter((l) => l.companion_id === "drevan")).toHaveLength(1);
    vi.unstubAllGlobals();
    const twice = stub(() => new Response(JSON.stringify({ error: "no", rule: "lexicon" }), { status: 422 }));
    await runDriftEvaluation(CONFIG, embedder);
    expect(twice.filter((l) => l.companion_id === "drevan")).toHaveLength(2);
  });
});
