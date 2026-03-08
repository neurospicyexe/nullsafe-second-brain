import { describe, it, expect, vi, beforeEach } from "vitest";
import { Indexer } from "../src/indexer.js";
import type { VaultAdapter } from "../src/adapters/vault-adapter.js";
import type { Embedder } from "../src/embeddings/embedder.js";
import { VectorStore } from "../src/store/vector-store.js";

const mockAdapter: VaultAdapter = {
  write: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue("# Test note\n\nContent here."),
  exists: vi.fn().mockResolvedValue(false),
  list: vi.fn().mockResolvedValue([]),
};

const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
};

describe("Indexer", () => {
  let store: VectorStore;
  let indexer: Indexer;

  beforeEach(() => {
    store = new VectorStore(":memory:");
    store.initialize();
    indexer = new Indexer(mockAdapter, mockEmbedder, store);
    vi.clearAllMocks();
  });

  it("writes to vault and indexes in vector store", async () => {
    await indexer.write({
      path: "00 - INBOX/test.md",
      content: "# Test\n\nSome content to embed.",
      companion: null,
      content_type: "note",
      tags: ["test"],
    });
    expect(mockAdapter.write).toHaveBeenCalledWith(
      expect.objectContaining({ path: "00 - INBOX/test.md" })
    );
    const chunks = store.getAll();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].vault_path).toBe("00 - INBOX/test.md");
    expect(chunks[0].content_type).toBe("note");
    expect(chunks[0].companion).toBeNull();
  });

  it("stores companion field correctly", async () => {
    await indexer.write({
      path: "Companions/a/story.md",
      content: "A story",
      companion: "companion-a",
      content_type: "document",
      tags: ["story"],
    });
    const chunks = store.getAll();
    expect(chunks[0].companion).toBe("companion-a");
    expect(chunks[0].tags).toEqual(["story"]);
  });

  it("reindex deletes old chunks and inserts new ones", async () => {
    await indexer.write({ path: "note.md", content: "original", companion: null, content_type: "note", tags: [] });
    const countBefore = store.getAll().filter(c => c.vault_path === "note.md").length;
    expect(countBefore).toBeGreaterThan(0);
    await indexer.reindex("note.md");
    const chunks = store.getAll().filter(c => c.vault_path === "note.md");
    expect(chunks.length).toBeGreaterThan(0); // new chunks inserted
  });

  it("reindex preserves companion and content_type", async () => {
    await indexer.write({
      path: "story.md",
      content: "original story",
      companion: "companion-a",
      content_type: "document",
      tags: ["story"],
    });
    // reset mock read to return updated content
    (mockAdapter.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce("updated story content");
    await indexer.reindex("story.md");
    const chunks = store.getAll().filter(c => c.vault_path === "story.md");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].companion).toBe("companion-a");
    expect(chunks[0].content_type).toBe("document");
    expect(chunks[0].tags).toEqual(["story"]);
  });

  it("write with empty content does not insert chunks", async () => {
    await indexer.write({ path: "empty.md", content: "   ", companion: null, content_type: "note", tags: [] });
    expect(store.getAll().filter(c => c.vault_path === "empty.md")).toHaveLength(0);
  });

  it("chunk text is stored in vector store", async () => {
    await indexer.write({ path: "a.md", content: "hello world", companion: null, content_type: "note", tags: [] });
    const chunks = store.getAll();
    expect(chunks.some(c => c.chunk_text.includes("hello world"))).toBe(true);
  });
});
