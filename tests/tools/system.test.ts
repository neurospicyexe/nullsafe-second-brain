import { describe, it, expect, vi } from "vitest";
import { buildSystemTools } from "../../src/tools/system.js";
import { VectorStore } from "../../src/store/vector-store.js";
import { Indexer } from "../../src/indexer.js";
import type { VaultAdapter } from "../../src/adapters/vault-adapter.js";
import type { Embedder } from "../../src/embeddings/embedder.js";

const mockAdapter: VaultAdapter = {
  write: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue("# content"),
  exists: vi.fn().mockResolvedValue(true),
  list: vi.fn().mockResolvedValue([]),
};
const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1]),
  embedBatch: vi.fn().mockResolvedValue([[0.1]]),
};

function makeSystem() {
  const store = new VectorStore(":memory:");
  store.initialize();
  const indexer = new Indexer(mockAdapter, mockEmbedder, store);
  return { tools: buildSystemTools(store, indexer, mockAdapter), store };
}

describe("system tools", () => {
  it("sb_status returns zero chunks on empty store", async () => {
    const { tools } = makeSystem();
    const status = await tools.sb_status();
    expect(status.total_chunks).toBe(0);
    expect(status.companions_indexed).toEqual([]);
  });

  it("sb_status reflects inserted chunks", async () => {
    const { tools, store } = makeSystem();
    store.insert({ vault_path: "a.md", companion: "companion-a", content_type: "document", chunk_text: "x", embedding: [0.1], tags: [] });
    store.insert({ vault_path: "b.md", companion: null, content_type: "note", chunk_text: "y", embedding: [0.2], tags: [] });
    const status = await tools.sb_status();
    expect(status.total_chunks).toBe(2);
    expect(status.companions_indexed).toContain("companion-a");
  });

  it("sb_reindex_note re-embeds a note", async () => {
    const { tools } = makeSystem();
    const result = await tools.sb_reindex_note({ path: "test.md" });
    expect(result.path).toBe("test.md");
    expect(result.status).toBe("reindexed");
    expect(mockAdapter.read).toHaveBeenCalled();
  });

  it("sb_index_rebuild processes all given paths", async () => {
    const { tools } = makeSystem();
    const result = await tools.sb_index_rebuild({ paths: ["a.md", "b.md", "c.md"] });
    expect(result.rebuilt).toBe(3);
  });
});
