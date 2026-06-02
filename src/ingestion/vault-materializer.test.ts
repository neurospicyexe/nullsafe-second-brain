import { describe, it, expect, vi, beforeEach } from "vitest";
import { runVaultMaterializer } from "./vault-materializer.js";
import type { IngestionConfig } from "./types.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

// Minimal IngestionConfig fixture — only halsethUrl/halsethSecret matter for
// the materializer; other fields are required by the type but unread here.
function makeConfig(): IngestionConfig {
  return {
    halsethUrl: "https://halseth.test",
    halsethSecret: "test-secret",
    deepseekApiKey: "x",
    deepseekModel: "deepseek-chat",
    cronSchedule: "*/20 * * * *",
    concurrencyLimit: 3,
    concurrencyDelayMs: 500,
    embeddingBatchSize: 20,
    hwmPath: "/tmp/hwm.json",
    evaluatorCronSchedule: "0 */6 * * *",
    sitPromptCronSchedule: "0 */12 * * *",
    patternSynthCronSchedule: "0 2 * * 0",
    personaFeederCronSchedule: "30 */6 * * *",
  };
}

interface CapturedWrite {
  path: string;
  content: string;
}

function makeMockVault(): { adapter: VaultAdapter; writes: CapturedWrite[]; deletes: string[] } {
  const writes: CapturedWrite[] = [];
  const deletes: string[] = [];
  const adapter: VaultAdapter = {
    write: async ({ path, content }) => { writes.push({ path, content }); },
    read: async () => "",
    exists: async () => false,
    list: async () => [],
    move: async () => undefined,
    delete: async (path: string) => { deletes.push(path); },
  };
  return { adapter, writes, deletes };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("runVaultMaterializer", () => {
  it("writes structured .md per row, resolves same-tick wikilinks, falls back to [[halseth/<id>]] for unresolved cross-tick refs, PATCHes vault_path", async () => {
    const { adapter, writes } = makeMockVault();
    const config = makeConfig();

    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url.endsWith("/mind/growth/unmaterialized/cypher?limit=100")) {
        return new Response(JSON.stringify({
          journal: [{
            id: "j1",
            entry_type: "insight",
            content: "Distributed failure stays in motion until something names it. Repair is a structural posture, not a tactic.",
            tags_json: JSON.stringify(["repair", "distributed"]),
            source: "autonomous",
            created_at: "2026-05-03T03:00:00Z",
            prehended_ids: JSON.stringify(["abc-123-peer-row"]),
            evidence_json: JSON.stringify([{ quote: "naming the failure binds the system", source_url: "https://x.test/y" }]),
            novelty: "deepening",
          }],
          patterns: [{
            id: "p1",
            pattern_text: "Repair architecture is the structural shape Cypher returns to under load",
            evidence_json: JSON.stringify([{ quote: "structural posture, not a tactic" }]),
            strength: 4,
            // Same-tick prehension: j1 is in this batch.
            prehended_ids: JSON.stringify(["j1"]),
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-03T03:00:00Z",
          }],
          markers: [{
            id: "m1",
            marker_type: "thoughtform",
            description: "Triad-shared shape: repair architecture (recurs across cypher+drevan)",
            related_pattern_id: null,
            // Mixed: p1 is same-tick (resolves), p-drevan is cross-tick + unknown (falls back).
            prehended_ids: JSON.stringify(["p1", "p-drevan"]),
            created_at: "2026-05-03T03:00:00Z",
          }],
        }), { status: 200 });
      }
      if (url.includes("/mind/growth/unmaterialized/")) {
        return new Response(JSON.stringify({ journal: [], patterns: [], markers: [] }), { status: 200 });
      }
      if (url.endsWith("/mind/growth/vault-paths") && init?.method === "POST") {
        // Cross-tick lookup: pretend abc-123-peer-row was already materialized,
        // p-drevan is unknown.
        return new Response(JSON.stringify({
          paths: {
            "abc-123-peer-row": "Companions/drevan/growth/journal/2026-04-29-old-entry.md",
            "p-drevan": null,
          },
        }), { status: 200 });
      }
      if (url.includes("/mind/growth/") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runVaultMaterializer(config, adapter);

    expect(result.written).toBe(3);
    expect(writes.length).toBe(3);

    const journalWrite = writes.find(w => w.path.includes("/journal/"));
    expect(journalWrite).toBeDefined();
    expect(journalWrite!.path).toMatch(/^Companions\/cypher\/growth\/journal\/2026-05-03-/);
    expect(journalWrite!.content).toContain("type: growth_journal");
    expect(journalWrite!.content).toContain("companion: cypher");
    expect(journalWrite!.content).toContain("novelty: deepening");
    expect(journalWrite!.content).toContain("halseth_id: j1");
    expect(journalWrite!.content).toContain("# Insight:");
    expect(journalWrite!.content).toContain("## Evidence");
    expect(journalWrite!.content).toContain("> naming the failure binds the system");
    expect(journalWrite!.content).toContain("<https://x.test/y>");
    expect(journalWrite!.content).toContain("## Prehended");
    // Cross-tick resolution: abc-123-peer-row → real wikilink with display label.
    expect(journalWrite!.content).toContain("[[Companions/drevan/growth/journal/2026-04-29-old-entry|2026-04-29-old-entry]]");

    const patternWrite = writes.find(w => w.path.includes("/patterns/"));
    expect(patternWrite).toBeDefined();
    expect(patternWrite!.content).toContain("strength: 4");
    expect(patternWrite!.content).toContain("**Strength:** 4/10");
    expect(patternWrite!.content).toContain("Subsequent runs that surface a similar shape will MERGE");
    // Same-tick resolution: j1 → real wikilink to the journal file we just wrote.
    expect(patternWrite!.content).toMatch(/\[\[Companions\/cypher\/growth\/journal\/2026-05-03-[^\]|]+\|2026-05-03-[^\]|]+\]\]/);

    const markerWrite = writes.find(w => w.path.includes("/markers/"));
    expect(markerWrite).toBeDefined();
    expect(markerWrite!.path).toContain("thoughtform");
    expect(markerWrite!.content).toContain("marker_type: thoughtform");
    expect(markerWrite!.content).toContain("Cross-companion crystallization");
    // p1 same-tick → resolves to the pattern file path
    expect(markerWrite!.content).toMatch(/\[\[Companions\/cypher\/growth\/patterns\/[^\]|]+\|[^\]|]+\]\]/);
    // p-drevan unresolved → falls back to dangling form
    expect(markerWrite!.content).toContain("[[halseth/p-drevan]]");

    // PATCH calls fired for each row
    const patchCalls = fetchMock.mock.calls.filter((c: any[]) => c[1]?.method === "PATCH");
    expect(patchCalls.length).toBe(3);
    expect(patchCalls.some((c: any[]) => c[0].includes("/mind/growth/journal/j1/vault"))).toBe(true);
    expect(patchCalls.some((c: any[]) => c[0].includes("/mind/growth/patterns/p1/vault"))).toBe(true);
    expect(patchCalls.some((c: any[]) => c[0].includes("/mind/growth/markers/m1/vault"))).toBe(true);

    // vault-paths POST fired with the cross-tick id only (j1/p1 are same-tick)
    const vpCalls = fetchMock.mock.calls.filter((c: any[]) => c[0].endsWith("/mind/growth/vault-paths"));
    expect(vpCalls.length).toBe(1);
    const vpBody = JSON.parse(vpCalls[0][1].body) as { ids: string[] };
    expect(vpBody.ids).toContain("abc-123-peer-row");
    expect(vpBody.ids).toContain("p-drevan");
    expect(vpBody.ids).not.toContain("j1");
    expect(vpBody.ids).not.toContain("p1");
  });

  it("un-materializes orphaned rows: deletes the vault file and clears vault_path", async () => {
    const { adapter, deletes } = makeMockVault();
    const config = makeConfig();
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url.endsWith("/mind/growth/unmaterialized/cypher?limit=100")) {
        return new Response(JSON.stringify({
          journal: [], patterns: [], markers: [],
          orphaned: [{ id: "orph-1", vault_path: "Companions/cypher/growth/journal/2026-06-01-declined.md" }],
        }), { status: 200 });
      }
      if (url.includes("/mind/growth/unmaterialized/")) {
        return new Response(JSON.stringify({ journal: [], patterns: [], markers: [], orphaned: [] }), { status: 200 });
      }
      if (url.includes("/mind/growth/") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true, vault_path: null }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runVaultMaterializer(config, adapter);

    // The orphaned file was deleted from the vault.
    expect(deletes).toContain("Companions/cypher/growth/journal/2026-06-01-declined.md");
    // vault_path cleared via PATCH null on the journal row (delete-first, then clear).
    const clearCalls = fetchMock.mock.calls.filter((c: any[]) =>
      c[0].includes("/mind/growth/journal/orph-1/vault") && c[1]?.method === "PATCH");
    expect(clearCalls.length).toBe(1);
    expect(JSON.parse(clearCalls[0][1].body).vault_path).toBe(null);
  });

  it("does NOT call vault-paths when there are no cross-tick prehensions", async () => {
    const { adapter } = makeMockVault();
    const config = makeConfig();
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url.endsWith("/mind/growth/unmaterialized/cypher?limit=100")) {
        return new Response(JSON.stringify({
          journal: [{
            id: "j-x", entry_type: "learning", content: "x",
            tags_json: "[]", source: "autonomous", created_at: "2026-05-03T03:00:00Z",
            prehended_ids: "[]", evidence_json: "[]", novelty: null,
          }],
          patterns: [], markers: [],
        }), { status: 200 });
      }
      if (url.includes("/mind/growth/unmaterialized/")) {
        return new Response(JSON.stringify({ journal: [], patterns: [], markers: [] }), { status: 200 });
      }
      if (init?.method === "PATCH") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await runVaultMaterializer(config, adapter);
    const vpCalls = fetchMock.mock.calls.filter((c: any[]) => c[0].endsWith("/mind/growth/vault-paths"));
    expect(vpCalls.length).toBe(0);
  });

  it("survives malformed JSON columns from Halseth (renders empty arrays, doesn't crash)", async () => {
    const { adapter, writes } = makeMockVault();
    const config = makeConfig();

    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url.includes("/mind/growth/unmaterialized/cypher")) {
        return new Response(JSON.stringify({
          journal: [{
            id: "j-bad",
            entry_type: "learning",
            content: "Some content",
            tags_json: "not-valid-json",
            source: "autonomous",
            created_at: "2026-05-03T03:00:00Z",
            prehended_ids: "{also bad",
            evidence_json: null,
            novelty: null,
          }],
          patterns: [],
          markers: [],
        }), { status: 200 });
      }
      if (url.includes("/mind/growth/unmaterialized/")) {
        return new Response(JSON.stringify({ journal: [], patterns: [], markers: [] }), { status: 200 });
      }
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runVaultMaterializer(config, adapter);
    expect(result.written).toBe(1);
    expect(result.failed).toBe(0);

    const w = writes[0]!;
    // No Evidence / Prehended sections when arrays are empty.
    expect(w.content).not.toContain("## Evidence");
    expect(w.content).not.toContain("## Prehended");
  });

  it("PATCH failure marks the row skipped (not failed) and does not throw", async () => {
    const { adapter, writes } = makeMockVault();
    const config = makeConfig();

    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url.includes("/mind/growth/unmaterialized/cypher")) {
        return new Response(JSON.stringify({
          journal: [{
            id: "j-skip", entry_type: "learning", content: "x",
            tags_json: "[]", source: "autonomous", created_at: "2026-05-03T03:00:00Z",
            prehended_ids: "[]", evidence_json: "[]", novelty: null,
          }],
          patterns: [], markers: [],
        }), { status: 200 });
      }
      if (url.includes("/mind/growth/unmaterialized/")) {
        return new Response(JSON.stringify({ journal: [], patterns: [], markers: [] }), { status: 200 });
      }
      if (init?.method === "PATCH") {
        return new Response("oops", { status: 500 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runVaultMaterializer(config, adapter);
    expect(writes.length).toBe(1); // wrote the file
    expect(result.skipped).toBe(1); // but PATCH failed -> skipped
    expect(result.written).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("aggregates per-companion counts in perCompanion", async () => {
    const { adapter } = makeMockVault();
    const config = makeConfig();

    const fetchMock = vi.fn(async (url: string, init?: any) => {
      const m = url.match(/\/mind\/growth\/unmaterialized\/(\w+)/);
      if (m) {
        const c = m[1];
        if (c === "cypher") {
          return new Response(JSON.stringify({
            journal: [{ id: `j-${c}`, entry_type: "learning", content: "x", tags_json: "[]", source: "autonomous", created_at: "2026-05-03T00:00:00Z", prehended_ids: "[]", evidence_json: "[]", novelty: null }],
            patterns: [], markers: [],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ journal: [], patterns: [], markers: [] }), { status: 200 });
      }
      if (init?.method === "PATCH") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runVaultMaterializer(config, adapter);
    expect(result.perCompanion).toEqual({ cypher: 1, drevan: 0, gaia: 0 });
  });
});
