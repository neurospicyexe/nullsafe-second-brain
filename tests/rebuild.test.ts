import { describe, it, expect, vi, beforeEach } from "vitest";
import { Indexer } from "../src/indexer.js";
import type { VaultAdapter } from "../src/adapters/vault-adapter.js";
import type { Embedder } from "../src/embeddings/embedder.js";
import { VectorStore } from "../src/store/vector-store.js";

const mockAdapter: VaultAdapter = {
  write: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue("# Note\n\nReindexed content."),
  exists: vi.fn().mockResolvedValue(true),
  list: vi.fn().mockResolvedValue([]),
};

const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  embedBatch: vi.fn().mockImplementation((texts: string[]) =>
    Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
  ),
};

describe("VectorStore.clear", () => {
  it("wipes the entire index", () => {
    const store = new VectorStore(":memory:");
    store.initialize();
    store.insert({ vault_path: "a.md", companion: null, content_type: "note", chunk_text: "x", embedding: [0.1, 0.2, 0.3], tags: [] });
    store.insert({ vault_path: "b.md", companion: "cypher", content_type: "document", chunk_text: "y", embedding: [0.1, 0.2, 0.3], tags: [] });
    expect(store.getAll().length).toBe(2);
    store.clear();
    expect(store.getAll().length).toBe(0);
  });

  it("leaves the store usable after clear (vec0 recreated on next insert)", () => {
    const store = new VectorStore(":memory:");
    store.initialize();
    store.insert({ vault_path: "a.md", companion: null, content_type: "note", chunk_text: "x", embedding: [0.1, 0.2, 0.3], tags: [] });
    store.clear();
    store.insert({ vault_path: "c.md", companion: null, content_type: "note", chunk_text: "z", embedding: [0.4, 0.5, 0.6], tags: [] });
    expect(store.getAll().map((c) => c.vault_path)).toEqual(["c.md"]);
  });
});

describe("Indexer.rebuildAll", () => {
  let store: VectorStore;
  let indexer: Indexer;

  beforeEach(() => {
    store = new VectorStore(":memory:");
    store.initialize();
    indexer = new Indexer(mockAdapter, mockEmbedder, store);
    vi.clearAllMocks();
  });

  it("rebuilds every indexed path, preserving per-path metadata", async () => {
    await indexer.write({ path: "Companions/cy/note.md", content: "A", companion: "cypher", content_type: "document", tags: ["bond"] });
    await indexer.write({ path: "00 - INBOX/human.md", content: "B", companion: null, content_type: "note", tags: [] });

    const result = await indexer.rebuildAll();
    expect(result.paths).toBe(2);
    expect(result.chunks).toBeGreaterThan(0);

    const all = store.getAll();
    const cy = all.find((c) => c.vault_path === "Companions/cy/note.md");
    expect(cy?.companion).toBe("cypher");
    expect(cy?.content_type).toBe("document");
    expect(cy?.tags).toEqual(["bond"]);
    expect(all.find((c) => c.vault_path === "00 - INBOX/human.md")?.companion).toBeNull();
  });

  it("is idempotent — running twice converges to the same path set", async () => {
    await indexer.write({ path: "x.md", content: "A", companion: null, content_type: "note", tags: [] });
    const first = await indexer.rebuildAll();
    const second = await indexer.rebuildAll();
    expect(second.paths).toBe(first.paths);
    expect(second.chunks).toBe(first.chunks);
  });
});
