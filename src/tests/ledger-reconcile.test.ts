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
  runLedgerReconcile, runRecallReconcile, reconcileAfterIdKey, LEDGER_RECONCILE_FEED, RECONCILE_PAGE_LIMIT,
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

// ── Tie across runs (2026-09-26 integration pass) ─────────────────────────────────────────────────
// /ingest/ledger-ineligible is STRICTLY after `since` and tie-breaks on id. Within one run the reconcile
// already follows next.after_id; ACROSS runs the incremental mark used to be the cursor alone, so a run
// whose page 2 failed after page 1 ended mid-tie left the rest of that tie unreachable forever.
describe("runLedgerReconcile: a cursor tie at a page boundary survives a failed run", () => {
  it("persists after_id beside the mark and sends it back, so every dropped row is purged", async () => {
    const T = "2026-09-26T11:00:00.000Z";
    const rows = Array.from({ length: RECONCILE_PAGE_LIMIT + 2 }, (_, i) => ({
      id: `led_${String(i).padStart(4, "0")}`,
      // the last four share one cursor; page 1 (500 rows) ends two rows into the tie.
      cursor_at: i >= RECONCILE_PAGE_LIMIT - 2 ? T : new Date(Date.parse("2026-09-26T08:00:00.000Z") + i * 1000).toISOString(),
    }));
    for (const r of rows) put(store, ledgerMirrorPath(r.id), LINE);
    let failPage2 = true;
    const calls: URL[] = [];
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      const since = url.searchParams.get("since") ?? "1970-01-01T00:00:00.000Z";
      const after = url.searchParams.get("after_id") ?? "";
      const limit = Number(url.searchParams.get("limit"));
      if (after !== "" && failPage2) { failPage2 = false; return new Response("boom", { status: 503 }); }
      const items = rows.filter(r => r.cursor_at > since || (after !== "" && r.cursor_at === since && r.id > after)).slice(0, limit);
      const last = items[items.length - 1];
      const next = items.length < limit || !last ? null : { since: last.cursor_at, after_id: last.id };
      return new Response(JSON.stringify({ items, next }), { status: 200 });
    }) as unknown as typeof fetch;

    // Armed incremental, full sweep not due.
    saveHwm(config.hwmPath, { [LEDGER_RECONCILE_HWM_KEY]: "2026-09-26T07:00:00.000Z", [LEDGER_RECONCILE_FULL_AT_KEY]: new Date().toISOString() });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const r1 = await runLedgerReconcile(config, store, { fetchImpl: impl });
    expect(r1.mode).toBe("incremental");
    expect(r1.error).toMatch(/503/);
    expect(r1.removed_docs).toBe(RECONCILE_PAGE_LIMIT);
    const hwm = loadHwm(config.hwmPath);
    expect(hwm[LEDGER_RECONCILE_HWM_KEY]).toBe(T);
    expect(hwm[reconcileAfterIdKey(LEDGER_RECONCILE_FEED)]).toBe(`led_${String(RECONCILE_PAGE_LIMIT - 1).padStart(4, "0")}`);

    const r2 = await runLedgerReconcile(config, store, { fetchImpl: impl });
    expect(r2.error).toBeUndefined();
    const last = calls[calls.length - 1]!;
    expect(last.searchParams.get("since")).toBe(T);
    expect(last.searchParams.get("after_id")).toBe(`led_${String(RECONCILE_PAGE_LIMIT - 1).padStart(4, "0")}`);
    expect(r2.removed_docs).toBe(2);
    expect(store.filterByPathPrefix("rag/ledger/", 1000)).toHaveLength(0);
    expect(loadHwm(config.hwmPath)[reconcileAfterIdKey(LEDGER_RECONCILE_FEED)]).toBe(`led_${String(RECONCILE_PAGE_LIMIT + 1).padStart(4, "0")}`);
  });

  it("the journal feed never grows an after_id key (its feed includes ties when after_id is empty)", async () => {
    const { impl } = fakeHalseth({ "/ingest/recall-ineligible": { "": { items: [{ id: "cj_1", cursor_at: "2026-09-26T10:00:00.000Z" }], next: null } } });
    await runRecallReconcile(config, store, { fetchImpl: impl, forceFull: true });
    expect(Object.keys(loadHwm(config.hwmPath)).some(k => k.endsWith(".after_id"))).toBe(false);
  });
});
