import { describe, it, expect, vi } from "vitest";
import { Indexer } from "../src/indexer.js";
import type { VaultAdapter } from "../src/adapters/vault-adapter.js";
import type { Embedder } from "../src/embeddings/embedder.js";
import { VectorStore } from "../src/store/vector-store.js";

describe("Indexer.drainPendingIndex with a still-queued vault write (S-2)", () => {
  it("does not spend attempts on a 404 while the adapter still holds the write, then recovers", async () => {
    const store = new VectorStore(":memory:");
    store.initialize();
    let pending = true;
    const adapter: VaultAdapter = {
      write: vi.fn().mockResolvedValue({ delivered: false, queued: true }),
      read: vi.fn().mockImplementation(async () => {
        if (pending) throw new Error("File not found: q/note.md");
        return "# Queued\n\nbody";
      }),
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      move: vi.fn(),
      delete: vi.fn(),
      hasPending: () => pending,
    };
    const embedder: Embedder = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
    const idx = new Indexer(adapter, embedder, store);
    store.markPendingIndex("q/note.md", null, "note", [], "embedder down");
    for (let i = 0; i < 10; i++) await idx.drainPendingIndex();
    expect(store.pendingIndexCount()).toBe(1); // never dropped (cap is 5)
    pending = false;
    const r = await idx.drainPendingIndex();
    expect(r.recovered).toBe(1);
    expect(store.pendingIndexCount()).toBe(0);
  });

  it("still drops a 404 entry after the cap when the adapter holds nothing", async () => {
    const store = new VectorStore(":memory:");
    store.initialize();
    const adapter: VaultAdapter = {
      write: vi.fn(),
      read: vi.fn().mockRejectedValue(new Error("File not found: gone.md")),
      exists: vi.fn(),
      list: vi.fn(),
      move: vi.fn(),
      delete: vi.fn(),
      hasPending: () => false,
    };
    const embedder: Embedder = { embed: vi.fn(), embedBatch: vi.fn() };
    const idx = new Indexer(adapter, embedder, store);
    store.markPendingIndex("gone.md", null, "note", [], "x");
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 10; i++) await idx.drainPendingIndex();
    expect(store.pendingIndexCount()).toBe(0);
  });
});
