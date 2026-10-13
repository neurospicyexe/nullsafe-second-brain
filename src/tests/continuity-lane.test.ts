// Continuity notes lane (2026-10-13) -- the puller, the purge feed, and the retract seam.
//
// A companion's continuity notes followed it across substrates and stopped there: Drevan captured
// Abby's death in Claude.ai, his Discord boot knew, Cypher's search found nothing, and Raziel had to
// retell it. Pinned here: the puller maps halseth's kept-only feed into rag/wm_continuity_notes/<id>
// records that advance on the memory cursor with the note_id tiebreak; the purge deletes exactly the
// listed notes' mirrors (never a journal mirror) on its OWN marks; and a hand retraction reaches them.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../store/vector-store.js";
import { continuityMirrorPath, journalMirrorPath, parseRetractBody } from "../retract.js";
import {
  runContinuityReconcile, CONTINUITY_RECONCILE_FEED, CONTINUITY_RECONCILE_HWM_KEY, CONTINUITY_RECONCILE_FULL_AT_KEY,
  RECONCILE_HWM_KEY,
} from "../ingestion/recall-reconcile.js";
import { ALL_PULLERS, pullContinuityNotes } from "../ingestion/puller.js";
import { loadHwm } from "../ingestion/hwm.js";
import type { IngestionConfig } from "../ingestion/types.js";

let dir: string;
let store: VectorStore;
let config: IngestionConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-lane-"));
  store = new VectorStore(":memory:");
  store.initialize();
  config = {
    halsethUrl: "https://h.example", halsethSecret: "sek", deepseekApiKey: "d", deepseekModel: "m",
    cronSchedule: "", concurrencyLimit: 1, concurrencyDelayMs: 0, embeddingBatchSize: 1,
    hwmPath: path.join(dir, "hwm.json"), evaluatorCronSchedule: "", sitPromptCronSchedule: "",
    patternSynthCronSchedule: "", personaFeederCronSchedule: "", recallReconcileFullMinutes: 60,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

function put(vaultPath: string, contentType: string) {
  store.insert({
    vault_path: vaultPath, companion: "drevan", content_type: contentType,
    chunk_text: "x", prefixed_text: "x", chunk_index: 0, embedding: [0.1, 0.2, 0.3], tags: [],
  });
}

const CAPTURE = {
  note_id: "adee9aff-1101-44a0-a6c0-333db73a118e", agent_id: "drevan", note_type: "conversation_capture",
  content: "10/13 ~8:30am: Abby passed in the night.", salience: "normal", source: "conversation_capture",
  created_at: "2026-10-13T13:29:02.461Z", cursor_at: "2026-10-13T13:29:02.461Z",
};

describe("pullContinuityNotes", () => {
  it("is registered as a puller under its table name", () => {
    expect(ALL_PULLERS.some((p) => p.source === "wm_continuity_notes" && p.pull === pullContinuityNotes)).toBe(true);
  });

  it("asks for /ingest/continuity-notes with since and after_id, and maps each note to a record", async () => {
    const seen: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      seen.push(new URL(String(input)));
      return new Response(JSON.stringify({ items: [CAPTURE, { note_id: "", content: "malformed" }], next: null }), { status: 200 });
    }));
    const { records, error } = await pullContinuityNotes(config, "2026-10-13T00:00:00.000Z", "prev-id");
    expect(error).toBeUndefined();
    expect(seen[0].pathname).toBe("/ingest/continuity-notes");
    expect(seen[0].searchParams.get("since")).toBe("2026-10-13T00:00:00.000Z");
    expect(seen[0].searchParams.get("after_id")).toBe("prev-id");
    expect(records).toHaveLength(1); // the malformed row is not indexed
    const r = records[0];
    expect(r).toMatchObject({
      id: CAPTURE.note_id, source_type: "wm_continuity_notes", companion_id: "drevan",
      cursor: CAPTURE.cursor_at, cursor_id: CAPTURE.note_id, created_at: CAPTURE.created_at,
    });
    const doc = JSON.parse(r.content);
    expect(doc.content).toContain("Abby passed in the night");
    expect(doc).not.toHaveProperty("cursor_at"); // transport, not content
    expect(doc).not.toHaveProperty("thread_key");
  });

  it("sends no after_id without a since, and reports a failed fetch as an error", async () => {
    const seen: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      seen.push(new URL(String(input)));
      return new Response("nope", { status: 500, statusText: "boom" });
    }));
    const { records, error } = await pullContinuityNotes(config, undefined, "stray");
    expect(seen[0].searchParams.has("after_id")).toBe(false);
    expect(records).toEqual([]);
    expect(error).toMatch(/500/);
  });
});

describe("continuity reconcile", () => {
  it("FULL deletes exactly the listed notes' mirrors, never a journal mirror, on its own marks", async () => {
    put(continuityMirrorPath("draft-1"), "wm_continuity_notes");
    put(continuityMirrorPath("kept-1"), "wm_continuity_notes");
    put(journalMirrorPath("draft-1"), "companion_journal"); // same id, other lane: untouched
    const calls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      return new Response(JSON.stringify({
        mode: "full",
        items: [{ id: "draft-1", cursor_at: "2026-10-13T17:56:09.389Z" }, { id: "never-mirrored", cursor_at: "2026-10-12T00:00:00.000Z" }],
        next: null,
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await runContinuityReconcile(config, store, { fetchImpl, now: () => Date.parse("2026-10-13T18:30:00.000Z") });
    expect(res).toMatchObject({ mode: "full", listed: 2, removed_docs: 1 });
    expect(calls[0].pathname).toBe("/ingest/continuity-ineligible");
    expect(store.countByPath(continuityMirrorPath("draft-1"))).toBe(0);
    expect(store.countByPath(continuityMirrorPath("kept-1"))).toBe(1);
    expect(store.countByPath(journalMirrorPath("draft-1"))).toBe(1);

    const hwm = loadHwm(config.hwmPath);
    expect(hwm[CONTINUITY_RECONCILE_HWM_KEY]).toBe("2026-10-13T17:56:09.389Z");
    expect(hwm[CONTINUITY_RECONCILE_FULL_AT_KEY]).toBe("2026-10-13T18:30:00.000Z");
    expect(hwm[RECONCILE_HWM_KEY]).toBeUndefined(); // the journal feed's mark is not touched
  });

  it("the next run inside the hour is INCREMENTAL from its own mark", async () => {
    const urls: URL[] = [];
    const page = (items: unknown[]) => new Response(JSON.stringify({ mode: "x", items, next: null }), { status: 200 });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return page([{ id: "a", cursor_at: "2026-10-13T12:00:00.000Z" }]);
    }) as unknown as typeof fetch;
    const t0 = Date.parse("2026-10-13T12:30:00.000Z");
    await runContinuityReconcile(config, store, { fetchImpl, now: () => t0 });
    await runContinuityReconcile(config, store, { fetchImpl, now: () => t0 + 10 * 60_000 });
    expect(urls[0].searchParams.has("since")).toBe(false);
    expect(urls[1].searchParams.get("since")).toBe("2026-10-13T12:00:00.000Z");
    expect(CONTINUITY_RECONCILE_FEED.persistAfterId).toBeUndefined();
  });
});

describe("retract seam", () => {
  it("a hand retraction can reach a continuity mirror", () => {
    expect(parseRetractBody({ vault_path: continuityMirrorPath("adee9aff") })).toEqual({ path: "rag/wm_continuity_notes/adee9aff" });
  });
});
