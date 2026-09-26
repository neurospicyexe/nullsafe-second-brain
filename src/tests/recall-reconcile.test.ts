// Recall reconcile (2026-09-26) -- against a REAL VectorStore and a real hwm file.
//
// The journal feed is kept-only, so a rag/companion_journal/<id> mirror of a row that became a draft,
// was dropped, or was archived can never correct itself. The reconcile pages halseth's
// /ingest/recall-ineligible and deletes those mirrors through retractPath -- the same delete POST
// /retract uses. Pinned here: what is deleted (and what is not), the two modes and their marks,
// idempotency, a failed page, and the other half of the loop: a deleted mirror of a draft that is
// later kept IS indexed again by the pipeline.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../store/vector-store.js";
import { retractPath, journalMirrorPath } from "../retract.js";
import {
  runRecallReconcile, fullSweepDue, RECONCILE_HWM_KEY, RECONCILE_FULL_AT_KEY,
} from "../ingestion/recall-reconcile.js";
import { loadHwm, saveHwm } from "../ingestion/hwm.js";
import { parseRecallReconcileMinutes } from "../ingestion/config.js";
import type { IngestionConfig } from "../ingestion/types.js";

function put(store: VectorStore, vaultPath: string, text: string, chunks = 1) {
  for (let i = 0; i < chunks; i++) {
    store.insert({
      vault_path: vaultPath, companion: "drevan", content_type: "companion_journal",
      chunk_text: text, prefixed_text: text, chunk_index: i, embedding: [0.1, 0.2, 0.3], tags: [],
    });
  }
}

type Page = { items: Array<{ id: string; cursor_at?: string }>; next: Record<string, string> | null };

/** A fake halseth that serves pages keyed by the request's query string, and records every call. */
function fakeHalseth(pages: Record<string, Page | number>) {
  const calls: URL[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sek");
    const key = [...url.searchParams.entries()].filter(([k]) => k !== "limit").map(([k, v]) => `${k}=${v}`).join("&");
    const page = pages[key];
    if (page === undefined) throw new Error(`unexpected page request: ${key || "(first full page)"}`);
    if (typeof page === "number") return new Response("boom", { status: page });
    return new Response(JSON.stringify({ mode: "x", ...page }), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

let dir: string;
let store: VectorStore;
let config: IngestionConfig;
const T0 = Date.parse("2026-09-26T12:00:00.000Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-"));
  store = new VectorStore(":memory:");
  store.initialize();
  config = {
    halsethUrl: "https://h.example", halsethSecret: "sek", deepseekApiKey: "d", deepseekModel: "m",
    cronSchedule: "*/20 * * * *", concurrencyLimit: 1, concurrencyDelayMs: 0, embeddingBatchSize: 1,
    hwmPath: path.join(dir, "hwm.json"), evaluatorCronSchedule: "", sitPromptCronSchedule: "",
    patternSynthCronSchedule: "", personaFeederCronSchedule: "", recallReconcileFullMinutes: 60,
  };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("retractPath -- the one delete path", () => {
  it("removes every chunk at the path and reports the count; the doc is gone from lexical search too", () => {
    put(store, "rag/companion_journal/j1", "the fabricated glucose number four hundred", 2);
    put(store, "rag/companion_journal/j2", "an unrelated kept memory about the garden");
    expect(store.hybridSearch(null, "fabricated glucose", 10).map(r => r.vault_path)).toContain("rag/companion_journal/j1");
    expect(retractPath(store, "rag/companion_journal/j1")).toBe(2);
    expect(store.existsByPath("rag/companion_journal/j1")).toBe(false);
    expect(store.hybridSearch(null, "fabricated glucose", 10).map(r => r.vault_path)).not.toContain("rag/companion_journal/j1");
    expect(store.existsByPath("rag/companion_journal/j2")).toBe(true);
    expect(retractPath(store, "rag/companion_journal/j1")).toBe(0); // idempotent
  });

  it("journalMirrorPath is the pipeline's rag/<source_type>/<id> shape", () => {
    expect(journalMirrorPath("56a25489-b3d2")).toBe("rag/companion_journal/56a25489-b3d2");
    expect(journalMirrorPath(7)).toBe("rag/companion_journal/7");
  });
});

describe("runRecallReconcile", () => {
  it("with no mark: a FULL sweep pages by after_id, deletes exactly the listed mirrors, then arms both marks", async () => {
    put(store, journalMirrorPath("a-draft"), "draft words");
    put(store, journalMirrorPath("b-dropped"), "dropped words");
    put(store, journalMirrorPath("c-kept"), "kept words");
    put(store, "discord-live/1/2.md", "a live line");
    const { impl, calls } = fakeHalseth({
      "": { items: [{ id: "a-draft", cursor_at: "2026-09-20T00:00:00.000Z" }, { id: "b-dropped", cursor_at: "2026-09-26T09:00:00.000Z" }], next: { after_id: "b-dropped" } },
      "after_id=b-dropped": { items: [{ id: "z-never-mirrored", cursor_at: "2026-09-25T00:00:00.000Z" }], next: null },
    });
    const res = await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res).toMatchObject({ mode: "full", pages: 2, listed: 3, removed_docs: 2, removed_rows: 2 });
    expect(res.error).toBeUndefined();
    expect(calls[0]!.pathname).toBe("/ingest/recall-ineligible");
    expect(store.existsByPath(journalMirrorPath("a-draft"))).toBe(false);
    expect(store.existsByPath(journalMirrorPath("b-dropped"))).toBe(false);
    expect(store.existsByPath(journalMirrorPath("c-kept"))).toBe(true);
    expect(store.existsByPath("discord-live/1/2.md")).toBe(true);
    const hwm = loadHwm(config.hwmPath);
    expect(hwm[RECONCILE_HWM_KEY]).toBe("2026-09-26T09:00:00.000Z");   // max cursor seen
    expect(hwm[RECONCILE_FULL_AT_KEY]).toBe(new Date(T0).toISOString()); // the sweep's START
  });

  it("with a mark and a recent full sweep: INCREMENTAL from the mark, following since+after_id, advancing the mark", async () => {
    saveHwm(config.hwmPath, { [RECONCILE_HWM_KEY]: "2026-09-26T09:00:00.000Z", [RECONCILE_FULL_AT_KEY]: new Date(T0 - 10 * 60_000).toISOString(), companion_journal: "keep-me" });
    put(store, journalMirrorPath("n1"), "newly dropped");
    const { impl, calls } = fakeHalseth({
      "since=2026-09-26T09:00:00.000Z": { items: [{ id: "n1", cursor_at: "2026-09-26T10:00:00.000Z" }], next: { since: "2026-09-26T10:00:00.000Z", after_id: "n1" } },
      "since=2026-09-26T10:00:00.000Z&after_id=n1": { items: [{ id: "n2", cursor_at: "2026-09-26T11:00:00.000Z" }], next: null },
    });
    const res = await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res).toMatchObject({ mode: "incremental", pages: 2, listed: 2, removed_docs: 1 });
    expect(calls).toHaveLength(2);
    const hwm = loadHwm(config.hwmPath);
    expect(hwm[RECONCILE_HWM_KEY]).toBe("2026-09-26T11:00:00.000Z");
    expect(hwm[RECONCILE_FULL_AT_KEY]).toBe(new Date(T0 - 10 * 60_000).toISOString()); // untouched
    expect(hwm.companion_journal).toBe("keep-me"); // the puller's own mark is never touched
  });

  it("a full sweep is due again after the interval (archives stamp no time, so only a full sweep sees them)", async () => {
    saveHwm(config.hwmPath, { [RECONCILE_HWM_KEY]: "2026-09-26T09:00:00.000Z", [RECONCILE_FULL_AT_KEY]: new Date(T0 - 61 * 60_000).toISOString() });
    put(store, journalMirrorPath("old-archived"), "a salience-pruned row");
    const { impl } = fakeHalseth({ "": { items: [{ id: "old-archived", cursor_at: "2026-07-01T00:00:00.000Z" }], next: null } });
    const res = await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res.mode).toBe("full");
    expect(store.existsByPath(journalMirrorPath("old-archived"))).toBe(false);
    // The incremental mark never moves backward on an old cursor.
    expect(loadHwm(config.hwmPath)[RECONCILE_HWM_KEY]).toBe("2026-09-26T09:00:00.000Z");
  });

  it("forceFull (startup) sweeps in full even with a fresh mark", async () => {
    saveHwm(config.hwmPath, { [RECONCILE_HWM_KEY]: "2026-09-26T09:00:00.000Z", [RECONCILE_FULL_AT_KEY]: new Date(T0).toISOString() });
    const { impl, calls } = fakeHalseth({ "": { items: [], next: null } });
    const res = await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0, forceFull: true });
    expect(res.mode).toBe("full");
    expect(calls[0]!.searchParams.has("since")).toBe(false);
  });

  it("is idempotent: a second identical pass removes nothing", async () => {
    put(store, journalMirrorPath("a"), "x");
    const pages = { "": { items: [{ id: "a", cursor_at: "2026-09-20T00:00:00.000Z" }], next: null } };
    const first = await runRecallReconcile(config, store, { fetchImpl: fakeHalseth(pages).impl, now: () => T0, forceFull: true });
    const second = await runRecallReconcile(config, store, { fetchImpl: fakeHalseth(pages).impl, now: () => T0, forceFull: true });
    expect(first.removed_docs).toBe(1);
    expect(second.removed_docs).toBe(0);
  });

  it("a failed FULL page keeps the deletes already made but stamps nothing, so the next tick sweeps in full again", async () => {
    put(store, journalMirrorPath("a"), "x");
    const { impl } = fakeHalseth({ "": { items: [{ id: "a", cursor_at: "2026-09-26T11:00:00.000Z" }], next: { after_id: "a" } }, "after_id=a": 503 });
    const res = await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res.error).toMatch(/503/);
    expect(store.existsByPath(journalMirrorPath("a"))).toBe(false);
    expect(loadHwm(config.hwmPath)).toEqual({});
  });

  it("refuses to loop on a cursor that does not advance", async () => {
    const { impl } = fakeHalseth({ "": { items: [{ id: "a" }], next: { after_id: "a" } }, "after_id=a": { items: [{ id: "a" }], next: { after_id: "a" } } });
    const res = await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res.error).toMatch(/did not advance/);
  });

  it("a malformed halseth response is an error, not an empty sweep that stamps the mark", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    const res = await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res.error).toMatch(/malformed/);
    expect(loadHwm(config.hwmPath)).toEqual({});
  });
});

describe("fullSweepDue / RECALL_RECONCILE_FULL_MINUTES", () => {
  it("is due with no stamp, an unparseable stamp, interval 0, or once the interval has passed", () => {
    expect(fullSweepDue(undefined, 60, T0)).toBe(true);
    expect(fullSweepDue("garbage", 60, T0)).toBe(true);
    expect(fullSweepDue(new Date(T0).toISOString(), 0, T0)).toBe(true);
    expect(fullSweepDue(new Date(T0 - 59 * 60_000).toISOString(), 60, T0)).toBe(false);
    expect(fullSweepDue(new Date(T0 - 60 * 60_000).toISOString(), 60, T0)).toBe(true);
  });
  it("parses the env knob: default 60, 0 allowed, negatives clamp to 0, garbage falls back", () => {
    expect(parseRecallReconcileMinutes(undefined)).toBe(60);
    expect(parseRecallReconcileMinutes("")).toBe(60);
    expect(parseRecallReconcileMinutes("0")).toBe(0);
    expect(parseRecallReconcileMinutes("15")).toBe(15);
    expect(parseRecallReconcileMinutes("-5")).toBe(0);
    expect(parseRecallReconcileMinutes("soon")).toBe(60);
  });
});
