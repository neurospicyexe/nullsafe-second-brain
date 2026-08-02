// src/tests/pending-index.test.ts
//
// A WRITE MUST NOT FAIL BECAUSE A DERIVED INDEX CANNOT BE UPDATED.
//
// The hole this closes (2026-08-01, found while tracing an OpenAI quota outage):
//
// `Indexer.write()` writes the vault file FIRST, then embeds. Both were equally fatal, so with the embedder
// down every write reported failure to its caller -- while the file had already landed and was perfectly
// durable. Two harms at once: callers saw data loss where there was none (and may retry, duplicating), and
// NOTHING recorded that the file still needed indexing.
//
// The second harm is the permanent one. `rebuildAll()` enumerates `distinctPaths()` -- paths already IN the
// index -- so a file that was never indexed is invisible to the one tool built to repair the index. A
// week-long outage would have left a silent, unrecoverable hole in the long-term memory: writing kept
// succeeding, searching just quietly never included it, and nothing anywhere said so.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Indexer } from "../indexer.js";
import { VectorStore } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

const QUOTA = new Error("OpenAI embeddings error: 429 — You have no credits remaining.");

function setup(opts: { embedderFails: boolean }) {
  // In-memory store so the real pending_index SQL is exercised, not a mock of it.
  const store = new VectorStore(":memory:");
  // initialize() creates the schema. Without it every insert throws and the drain "recovers" nothing -- which
  // looked exactly like a broken drain on the first run of this file.
  store.initialize();
  const written = new Map<string, string>();
  const adapter = {
    write: vi.fn(async (a: { path: string; content: string }) => { written.set(a.path, a.content); }),
    read: vi.fn(async (p: string) => written.get(p) ?? "# recovered\n\nbody text"),
    list: vi.fn(async () => []),
    move: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
  } as unknown as VaultAdapter;

  let fail = opts.embedderFails;
  const embedder = {
    embed: vi.fn(async () => { if (fail) throw QUOTA; return [0.1, 0.2, 0.3]; }),
    embedBatch: vi.fn(async (t: string[]) => { if (fail) throw QUOTA; return t.map(() => [0.1, 0.2, 0.3]); }),
  } as unknown as Embedder;

  return { store, adapter, embedder, written, restoreEmbedder: () => { fail = false; } };
}

describe("Indexer.write -- the vault is truth, the index is derived", () => {
  it("the vault file SURVIVES an embedder failure and the write does not throw", async () => {
    const { store, adapter, embedder, written } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);

    const r = await indexer.write({
      path: "raziel/sessions/today.md", content: "what happened today",
      companion: "cypher", content_type: "session_summary", tags: [],
    });

    expect(r.indexed).toBe(false);
    expect(r.pending_reason).toContain("no credits remaining");
    expect(written.get("raziel/sessions/today.md")).toBe("what happened today");
  });

  it("QUEUES the path, so the gap is recorded rather than lost", async () => {
    const { store, adapter, embedder } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);

    await indexer.write({ path: "a.md", content: "x", companion: "gaia", content_type: "note", tags: ["t"] });

    expect(store.pendingIndexCount()).toBe(1);
    const [p] = store.listPendingIndex();
    expect(p.vault_path).toBe("a.md");
    expect(p.companion).toBe("gaia");
    expect(p.tags).toEqual(["t"]);
    expect(p.reason).toContain("429");
  });

  it("re-failing the same path counts attempts and KEEPS the original first_failed_at", async () => {
    const { store, adapter, embedder } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);

    await indexer.write({ path: "a.md", content: "x", companion: null, content_type: "note", tags: [] });
    const first = store.listPendingIndex()[0].first_failed_at;
    await indexer.write({ path: "a.md", content: "y", companion: null, content_type: "note", tags: [] });

    expect(store.pendingIndexCount()).toBe(1); // still one path, not two rows
    const p = store.listPendingIndex()[0];
    expect(p.attempts).toBe(2);
    // "How long has this been unsearchable" is the question that matters; a bumped timestamp would erase it.
    expect(p.first_failed_at).toBe(first);
  });

  it("a healthy write indexes and queues NOTHING", async () => {
    const { store, adapter, embedder } = setup({ embedderFails: false });
    const indexer = new Indexer(adapter, embedder, store);

    const r = await indexer.write({ path: "a.md", content: "hello world", companion: null, content_type: "note", tags: [] });

    expect(r.indexed).toBe(true);
    expect(store.pendingIndexCount()).toBe(0);
  });

  it("a later successful write CLEARS an earlier pending entry", async () => {
    const { store, adapter, embedder, restoreEmbedder } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);

    await indexer.write({ path: "a.md", content: "x", companion: null, content_type: "note", tags: [] });
    expect(store.pendingIndexCount()).toBe(1);

    restoreEmbedder();
    await indexer.write({ path: "a.md", content: "x", companion: null, content_type: "note", tags: [] });
    expect(store.pendingIndexCount()).toBe(0);
  });
});

describe("Indexer.drainPendingIndex -- recovery needs nobody to remember", () => {
  it("recovers queued files once the embedder works, and empties the queue", async () => {
    const { store, adapter, embedder, restoreEmbedder } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);

    await indexer.write({ path: "a.md", content: "alpha", companion: null, content_type: "note", tags: [] });
    await indexer.write({ path: "b.md", content: "beta", companion: null, content_type: "note", tags: [] });
    expect(store.pendingIndexCount()).toBe(2);

    restoreEmbedder();
    const r = await indexer.drainPendingIndex();

    expect(r.recovered).toBe(2);
    expect(r.still_pending).toBe(0);
    expect(store.pendingIndexCount()).toBe(0);
  });

  it("STOPS at the first failure rather than hammering a dead paid API once per queued file", async () => {
    const { store, adapter, embedder } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);

    for (const p of ["a.md", "b.md", "c.md", "d.md"]) {
      await indexer.write({ path: p, content: p, companion: null, content_type: "note", tags: [] });
    }
    // BOTH mocks: indexContent may route through embedBatch, so clearing only `embed` leaves the four write
    // calls in the count and the assertion measures nothing.
    vi.mocked(embedder.embed).mockClear();
    vi.mocked(embedder.embedBatch as unknown as ReturnType<typeof vi.fn>).mockClear();

    const r = await indexer.drainPendingIndex();

    expect(r.recovered).toBe(0);
    expect(store.pendingIndexCount()).toBe(4); // nothing lost
    // One attempt, not four: a still-unfunded key should cost one call per tick, not one per backlog entry.
    expect(vi.mocked(embedder.embed).mock.calls.length + vi.mocked(embedder.embedBatch as any).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("is a cheap no-op when the queue is empty", async () => {
    const { store, adapter, embedder } = setup({ embedderFails: false });
    const indexer = new Indexer(adapter, embedder, store);

    const r = await indexer.drainPendingIndex();
    expect(r).toEqual({ attempted: 0, recovered: 0, still_pending: 0 });
  });

  it("a MISSING FILE does not block the rest of the queue -- the poison-pill guard", async () => {
    // Before this guard, drainPendingIndex broke on the FIRST failure. Right for "embedder still down";
    // catastrophic for a path whose vault file was deleted or renamed -- that entry throws forever, sits at
    // the head of an oldest-first list, and permanently blocks every other queued file from draining, even
    // after the embedder recovers. pending_index would never clear and sb_status would report a hole that
    // could never close.
    const { store, adapter, embedder, restoreEmbedder } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);
    await indexer.write({ path: "gone.md", content: "x", companion: null, content_type: "note", tags: [] });
    await indexer.write({ path: "fine.md", content: "y", companion: null, content_type: "note", tags: [] });
    expect(store.pendingIndexCount()).toBe(2);

    restoreEmbedder();
    // gone.md can no longer be read; fine.md can.
    vi.mocked(adapter.read).mockImplementation(async (path: string) => {
      if (path === "gone.md") throw new Error("ENOENT: no such file or directory");
      return "recovered body";
    });

    const r = await indexer.drainPendingIndex();

    expect(r.recovered).toBe(1);                       // fine.md drained past the bad head entry
    expect(store.listPendingIndex().map(p => p.vault_path)).toEqual(["gone.md"]);
  });

  it("an EMBEDDER failure still stops the tick -- one dead-API call, not one per queued file", async () => {
    const { store, adapter, embedder } = setup({ embedderFails: true });
    const indexer = new Indexer(adapter, embedder, store);
    for (const p of ["a.md", "b.md", "c.md"]) {
      await indexer.write({ path: p, content: p, companion: null, content_type: "note", tags: [] });
    }
    vi.mocked(embedder.embed).mockClear();
    vi.mocked(embedder.embedBatch as unknown as ReturnType<typeof vi.fn>).mockClear();

    const r = await indexer.drainPendingIndex();

    expect(r.recovered).toBe(0);
    expect(store.pendingIndexCount()).toBe(3);        // nothing dropped -- an outage must never lose a path
  });
});
