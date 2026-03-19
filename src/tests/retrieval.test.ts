import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRetrievalTools } from "../tools/retrieval.js";
import type { VectorStore, ChunkRow } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";

// Minimal ChunkRow factory
function makeChunk(overrides: Partial<ChunkRow> & { vault_path: string }): ChunkRow & { score: number } {
  return {
    id: "id-" + Math.random(),
    vault_path: overrides.vault_path,
    companion: null,
    content_type: "note",
    chunk_text: overrides.chunk_text ?? "default chunk text",
    prefixed_text: overrides.prefixed_text ?? null,
    section: overrides.section ?? null,
    chunk_index: null,
    embedding: [0.1, 0.2, 0.3],
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    score: overrides.score ?? 0.9,
    ...overrides,
  };
}

function buildMocks(hybridResults: Array<ChunkRow & { score: number }>) {
  const store = {
    hybridSearch: vi.fn().mockReturnValue(hybridResults),
    getAll: vi.fn().mockReturnValue([]),
    filterByCompanion: vi.fn().mockReturnValue([]),
  } as unknown as VectorStore;

  const embedder = {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  } as unknown as Embedder;

  return { store, embedder };
}

describe("sb_search", () => {
  it("calls hybridSearch, not getAll", async () => {
    const { store, embedder } = buildMocks([]);
    const tools = buildRetrievalTools(store, embedder);

    await tools.sb_search({ query: "test query", limit: 5 });

    expect(store.hybridSearch).toHaveBeenCalledOnce();
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it("passes queryEmbedding and queryText to hybridSearch", async () => {
    const { store, embedder } = buildMocks([]);
    const tools = buildRetrievalTools(store, embedder);

    await tools.sb_search({ query: "hello world", limit: 3 });

    expect(embedder.embed).toHaveBeenCalledWith("hello world");
    const [embedding, text] = (store.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(text).toBe("hello world");
  });

  it("oversamples by 5x when calling hybridSearch", async () => {
    const { store, embedder } = buildMocks([]);
    const tools = buildRetrievalTools(store, embedder);

    await tools.sb_search({ query: "q", limit: 4 });

    const [, , limit] = (store.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(limit).toBe(20); // 4 * 5
  });

  it("deduplicates: keeps at most 2 results per vault_path", async () => {
    const chunks = [
      makeChunk({ vault_path: "notes/a.md", score: 0.95 }),
      makeChunk({ vault_path: "notes/a.md", score: 0.90 }),
      makeChunk({ vault_path: "notes/a.md", score: 0.85 }), // 3rd from same path -- should be dropped
      makeChunk({ vault_path: "notes/a.md", score: 0.80 }),
      makeChunk({ vault_path: "notes/a.md", score: 0.75 }),
      makeChunk({ vault_path: "notes/b.md", score: 0.70 }),
    ];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 10 });

    const fromA = result.chunks.filter((c: { vault_path: string }) => c.vault_path === "notes/a.md");
    const fromB = result.chunks.filter((c: { vault_path: string }) => c.vault_path === "notes/b.md");
    expect(fromA).toHaveLength(2);
    expect(fromB).toHaveLength(1);
  });

  it("respects limit after dedup", async () => {
    const chunks = [
      makeChunk({ vault_path: "a.md", score: 0.99 }),
      makeChunk({ vault_path: "b.md", score: 0.98 }),
      makeChunk({ vault_path: "c.md", score: 0.97 }),
      makeChunk({ vault_path: "d.md", score: 0.96 }),
      makeChunk({ vault_path: "e.md", score: 0.95 }),
    ];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 2 });

    expect(result.chunks).toHaveLength(2);
  });

  it("prefers chunk_text over content when chunk_text is non-null", async () => {
    const chunks = [
      makeChunk({ vault_path: "a.md", chunk_text: "display text", prefixed_text: "prefix: display text", score: 0.9 }),
    ];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0].text).toBe("display text");
  });

  it("falls back to prefixed_text (content) when chunk_text is null/empty", async () => {
    // ChunkRow.chunk_text is non-nullable in the type but we test the fallback path
    const chunk = makeChunk({ vault_path: "a.md", score: 0.9 });
    // Force chunk_text to null to simulate missing display text
    (chunk as unknown as Record<string, unknown>).chunk_text = null;
    chunk.prefixed_text = "prefixed fallback content";

    const { store, embedder } = buildMocks([chunk]);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0].text).toBe("prefixed fallback content");
  });

  it("returns correct shape: vault_path, text, section, score", async () => {
    const chunks = [
      makeChunk({ vault_path: "notes/x.md", chunk_text: "chunk content", section: "Introduction", score: 0.88 }),
    ];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    const item = result.chunks[0];
    expect(item).toMatchObject({
      vault_path: "notes/x.md",
      text: "chunk content",
      section: "Introduction",
      score: 0.88,
    });
  });

  it("section defaults to empty string when null", async () => {
    const chunks = [makeChunk({ vault_path: "a.md", section: null, score: 0.5 })];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0].section).toBe("");
  });

  it("default limit is 10 when not provided", async () => {
    const { store, embedder } = buildMocks([]);
    const tools = buildRetrievalTools(store, embedder);

    await tools.sb_search({ query: "q" });

    const [, , limit] = (store.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(limit).toBe(50); // 10 * 5
  });
});
