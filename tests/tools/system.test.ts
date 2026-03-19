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
  move: vi.fn().mockResolvedValue(undefined),
};
const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
};

function makeSystem() {
  const store = new VectorStore(":memory:");
  store.initialize();
  const indexer = new Indexer(mockAdapter, mockEmbedder, store);
  return { tools: buildSystemTools(store, indexer, mockAdapter, mockEmbedder), store };
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

  it("sb_index_rebuild processes all given paths", async () => {
    const { tools } = makeSystem();
    const result = await tools.sb_index_rebuild({ paths: ["a.md", "b.md", "c.md"] });
    expect(result.rebuilt).toBe(3);
  });

  // ── sb_read: no-query mode (existing behavior) ────────────────────────────

  it("sb_read with no query returns full content", async () => {
    const { tools } = makeSystem();
    const result = await tools.sb_read({ path: "some/note.md" });
    expect(result).toHaveProperty("content");
    expect((result as { content: string }).content).toBe("# content");
    expect(result).not.toHaveProperty("mode");
  });

  // ── sb_read: query mode ───────────────────────────────────────────────────

  it("sb_read with query and chunks returns excerpt mode", async () => {
    const { tools, store } = makeSystem();
    // Insert 4 chunks for the path with varying embeddings
    store.insert({
      vault_path: "notes/test.md",
      companion: null,
      content_type: "document",
      chunk_text: "chunk A text",
      embedding: [1, 0, 0],
      section: "Section A",
      tags: [],
    });
    store.insert({
      vault_path: "notes/test.md",
      companion: null,
      content_type: "document",
      chunk_text: "chunk B text",
      embedding: [0, 1, 0],
      section: "Section B",
      tags: [],
    });
    store.insert({
      vault_path: "notes/test.md",
      companion: null,
      content_type: "document",
      chunk_text: "chunk C text",
      embedding: [0, 0, 1],
      section: "Section C",
      tags: [],
    });
    store.insert({
      vault_path: "notes/test.md",
      companion: null,
      content_type: "document",
      chunk_text: "chunk D text",
      embedding: [0.5, 0.5, 0],
      section: "Section D",
      tags: [],
    });

    // Query embedding [1, 0, 0] most similar to chunk A, then D, then B/C
    (mockEmbedder.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce([1, 0, 0]);

    const result = await tools.sb_read({ path: "notes/test.md", query: "something about A" });

    expect(result).toHaveProperty("mode", "excerpts");
    const typed = result as { path: string; mode: string; excerpts: Array<{ section: string; text: string }> };
    expect(typed.path).toBe("notes/test.md");
    expect(typed.excerpts).toHaveLength(3);
    // Most similar first: chunk A ([1,0,0] · [1,0,0] = 1.0)
    expect(typed.excerpts[0].text).toBe("chunk A text");
    expect(typed.excerpts[0].section).toBe("Section A");
  });

  it("sb_read with query ranks by cosine similarity (most similar first)", async () => {
    const { tools, store } = makeSystem();
    store.insert({
      vault_path: "doc.md", companion: null, content_type: "document",
      chunk_text: "low similarity chunk", embedding: [0, 1, 0], section: "Low", tags: [],
    });
    store.insert({
      vault_path: "doc.md", companion: null, content_type: "document",
      chunk_text: "high similarity chunk", embedding: [1, 0, 0], section: "High", tags: [],
    });
    store.insert({
      vault_path: "doc.md", companion: null, content_type: "document",
      chunk_text: "medium similarity chunk", embedding: [0.7, 0.7, 0], section: "Mid", tags: [],
    });

    // Query most similar to [1, 0, 0]
    (mockEmbedder.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce([1, 0, 0]);

    const result = await tools.sb_read({ path: "doc.md", query: "high" }) as {
      mode: string; excerpts: Array<{ section: string; text: string }>;
    };
    expect(result.mode).toBe("excerpts");
    expect(result.excerpts[0].section).toBe("High");
  });

  it("sb_read with query falls back to full content when no chunks exist for path", async () => {
    const { tools } = makeSystem();
    (mockEmbedder.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce([1, 0, 0]);

    const result = await tools.sb_read({ path: "empty/path.md", query: "anything" });
    // No chunks indexed for this path -- should fall back to full content
    expect(result).toHaveProperty("content");
    expect(result).not.toHaveProperty("mode");
  });

  it("sb_read with query prefers chunk_text over content for excerpt text", async () => {
    const { tools, store } = makeSystem();
    // chunk_text is the actual text field on ChunkRow (no separate "content" field)
    // chunk_text should be used; section null defaults to ""
    store.insert({
      vault_path: "p.md", companion: null, content_type: "note",
      chunk_text: "the real chunk text", embedding: [1, 0, 0],
      section: null as unknown as string,
      tags: [],
    });

    (mockEmbedder.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce([1, 0, 0]);

    const result = await tools.sb_read({ path: "p.md", query: "test" }) as {
      mode: string; excerpts: Array<{ section: string; text: string }>;
    };
    expect(result.mode).toBe("excerpts");
    expect(result.excerpts[0].text).toBe("the real chunk text");
    expect(result.excerpts[0].section).toBe("");
  });

  it("sb_read with query returns at most 3 excerpts", async () => {
    const { tools, store } = makeSystem();
    for (let i = 0; i < 5; i++) {
      store.insert({
        vault_path: "many.md", companion: null, content_type: "document",
        chunk_text: `chunk ${i}`, embedding: [i / 5, 1 - i / 5, 0], tags: [],
      });
    }
    (mockEmbedder.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce([1, 0, 0]);

    const result = await tools.sb_read({ path: "many.md", query: "x" }) as {
      mode: string; excerpts: Array<{ section: string; text: string }>;
    };
    expect(result.mode).toBe("excerpts");
    expect(result.excerpts.length).toBeLessThanOrEqual(3);
  });
});
