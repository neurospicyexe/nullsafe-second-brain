// Ledger reconcile (2026-09-26, imp-lane tranche 1) -- against a REAL VectorStore and a real hwm file.
//
// Drevan's rule: "a drop purges the chunk". `drop ledger <id>` lists the id on halseth's
// /ingest/ledger-ineligible; this pins that the reconcile deletes rag/ledger/<id> (and nothing else),
// through retractPath, with its OWN marks (never the journal feed's), full then incremental, reading
// the item cursor as cursor_at or state_at.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../store/vector-store.js";
import { ledgerMirrorPath, journalMirrorPath } from "../retract.js";
import {
  runLedgerReconcile, runRecallReconcile,
  LEDGER_RECONCILE_HWM_KEY, LEDGER_RECONCILE_FULL_AT_KEY, RECONCILE_HWM_KEY, RECONCILE_FULL_AT_KEY,
} from "../ingestion/recall-reconcile.js";
import { loadHwm, saveHwm } from "../ingestion/hwm.js";
import type { IngestionConfig } from "../ingestion/types.js";

const LINE = "〔ledger · gap-reader · 2026-09-26〕 Missing: no companion note recorded. Source: session s1.";

function put(store: VectorStore, vaultPath: string, text: string, contentType = "ledger") {
  store.insert({
    vault_path: vaultPath, companion: "drevan", content_type: contentType,
    chunk_text: text, prefixed_text: text, chunk_index: 0, embedding: [0.1, 0.2, 0.3], tags: [],
  });
}

type Page = { items: Array<{ id: string; cursor_at?: string; state_at?: string }>; next: Record<string, string> | null };

function fakeHalseth(routes: Record<string, Record<string, Page | number>>) {
  const calls: URL[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const pages = routes[url.pathname];
    if (!pages) throw new Error(`unexpected endpoint ${url.pathname}`);
    const key = [...url.searchParams.entries()].filter(([k]) => k !== "limit").map(([k, v]) => `${k}=${v}`).join("&");
    const page = pages[key];
    if (page === undefined) throw new Error(`unexpected page request: ${url.pathname} ${key}`);
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-reconcile-"));
  store = new VectorStore(":memory:");
  store.initialize();
  config = {
    halsethUrl: "https://h.example", halsethSecret: "sek", deepseekApiKey: "d", deepseekModel: "m",
    cronSchedule: "", concurrencyLimit: 1, concurrencyDelayMs: 0, embeddingBatchSize: 1,
    hwmPath: path.join(dir, "hwm.json"), evaluatorCronSchedule: "", sitPromptCronSchedule: "",
    patternSynthCronSchedule: "", personaFeederCronSchedule: "", recallReconcileFullMinutes: 60,
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runLedgerReconcile", () => {
  it("FULL sweep of /ingest/ledger-ineligible purges exactly the dropped rag/ledger/<id> chunks, then arms its OWN marks", async () => {
    put(store, ledgerMirrorPath("led_dropped"), LINE);
    put(store, ledgerMirrorPath("led_open"), LINE.replace("s1", "s2"));
    put(store, journalMirrorPath("led_dropped"), "same id, other lane", "companion_journal");
    const { impl, calls } = fakeHalseth({
      "/ingest/ledger-ineligible": {
        "": { items: [{ id: "led_dropped", state_at: "2026-09-26T09:00:00.000Z" }], next: { after_id: "led_dropped" } },
        "after_id=led_dropped": { items: [{ id: "led_never_indexed", state_at: "2026-09-26T08:00:00.000Z" }], next: null },
      },
    });
    const res = await runLedgerReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res).toMatchObject({ mode: "full", pages: 2, listed: 2, removed_docs: 1, removed_rows: 1 });
    expect(calls.every(c => c.pathname === "/ingest/ledger-ineligible")).toBe(true);
    expect(store.existsByPath(ledgerMirrorPath("led_dropped"))).toBe(false);
    expect(store.hybridSearch(null, "companion note recorded", 10).map(r => r.vault_path)).not.toContain(ledgerMirrorPath("led_dropped"));
    expect(store.existsByPath(ledgerMirrorPath("led_open"))).toBe(true);
    expect(store.existsByPath(journalMirrorPath("led_dropped"))).toBe(true);
    const hwm = loadHwm(config.hwmPath);
    expect(hwm[LEDGER_RECONCILE_HWM_KEY]).toBe("2026-09-26T09:00:00.000Z"); // state_at read as the cursor
    expect(hwm[LEDGER_RECONCILE_FULL_AT_KEY]).toBe(new Date(T0).toISOString());
    expect(hwm[RECONCILE_HWM_KEY]).toBeUndefined();
    expect(hwm[RECONCILE_FULL_AT_KEY]).toBeUndefined();
  });

  it("INCREMENTAL from its own mark once a full sweep is recent; idempotent on an already-purged id", async () => {
    saveHwm(config.hwmPath, {
      [LEDGER_RECONCILE_HWM_KEY]: "2026-09-26T09:00:00.000Z",
      [LEDGER_RECONCILE_FULL_AT_KEY]: new Date(T0 - 5 * 60_000).toISOString(),
      [RECONCILE_HWM_KEY]: "journal-mark-untouched",
    });
    put(store, ledgerMirrorPath("led_new_drop"), LINE);
    const { impl } = fakeHalseth({
      "/ingest/ledger-ineligible": {
        "since=2026-09-26T09:00:00.000Z": {
          items: [{ id: "led_new_drop", cursor_at: "2026-09-26T11:00:00.000Z" }, { id: "led_dropped_long_ago", cursor_at: "2026-09-26T11:30:00.000Z" }],
          next: null,
        },
      },
    });
    const res = await runLedgerReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res).toMatchObject({ mode: "incremental", listed: 2, removed_docs: 1 });
    expect(store.existsByPath(ledgerMirrorPath("led_new_drop"))).toBe(false);
    const hwm = loadHwm(config.hwmPath);
    expect(hwm[LEDGER_RECONCILE_HWM_KEY]).toBe("2026-09-26T11:30:00.000Z");
    expect(hwm[RECONCILE_HWM_KEY]).toBe("journal-mark-untouched");
  });

  it("a failing feed (e.g. 404 before Halseth ships the lane) is reported, not thrown, and moves no mark", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    put(store, ledgerMirrorPath("led_x"), LINE);
    const { impl } = fakeHalseth({ "/ingest/ledger-ineligible": { "": 404 } });
    const res = await runLedgerReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(res.error).toMatch(/ledger-ineligible 404/);
    expect(store.existsByPath(ledgerMirrorPath("led_x"))).toBe(true);
    expect(loadHwm(config.hwmPath)[LEDGER_RECONCILE_HWM_KEY]).toBeUndefined();
  });

  it("the journal reconcile still reads only its own feed and marks", async () => {
    put(store, journalMirrorPath("j1"), "draft words", "companion_journal");
    put(store, ledgerMirrorPath("j1"), LINE);
    const { impl, calls } = fakeHalseth({ "/ingest/recall-ineligible": { "": { items: [{ id: "j1", cursor_at: "2026-09-26T01:00:00.000Z" }], next: null } } });
    await runRecallReconcile(config, store, { fetchImpl: impl, now: () => T0 });
    expect(calls.map(c => c.pathname)).toEqual(["/ingest/recall-ineligible"]);
    expect(store.existsByPath(journalMirrorPath("j1"))).toBe(false);
    expect(store.existsByPath(ledgerMirrorPath("j1"))).toBe(true);
    expect(loadHwm(config.hwmPath)[LEDGER_RECONCILE_HWM_KEY]).toBeUndefined();
  });
});
