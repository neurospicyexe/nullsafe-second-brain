import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRetrievalTools } from "../tools/retrieval.js";
import type { VectorStore, ChunkRow } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";

// Minimal ChunkRow factory
function makeChunk(overrides: Partial<ChunkRow & { score: number }> & { vault_path: string }): ChunkRow & { score: number } {
  return {
    id: "id-" + Math.random(),
    companion: null,
    content_type: "note",
    chunk_text: "default chunk text",
    prefixed_text: null,
    section: null,
    chunk_index: null,
    embedding: [0.1, 0.2, 0.3],
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    novelty_score: 1.0,
    last_surfaced_at: null,
    score: 0.9,
    ...overrides,
  };
}

function buildMocks(hybridResults: Array<ChunkRow & { score: number }>) {
  const store = {
    hybridSearch: vi.fn().mockReturnValue(hybridResults),
    noveltySearch: vi.fn().mockReturnValue([]),
    edgeSearch: vi.fn().mockReturnValue([]),
    updateNoveltyScores: vi.fn(),
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

  it("oversamples pool1 by 5x when calling hybridSearch", async () => {
    const { store, embedder } = buildMocks([]);
    const tools = buildRetrievalTools(store, embedder);

    // limit=4, pool1Size = Math.round(4 * 0.7) = 3, oversample = 3 * 5 = 15
    await tools.sb_search({ query: "q", limit: 4 });

    const [, , limit] = (store.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(limit).toBe(15);
  });

  it("calls noveltySearch with excludedIds from pool1", async () => {
    const chunk = makeChunk({ vault_path: "a.md", score: 0.9 });
    const { store, embedder } = buildMocks([chunk]);
    const tools = buildRetrievalTools(store, embedder);

    // limit=10, pool1Size=7, pool2Size=2
    await tools.sb_search({ query: "q", limit: 10 });

    const [pool2Limit, excludeIds] = (store.noveltySearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pool2Limit).toBe(2);
    expect(excludeIds).toContain(chunk.id);
  });

  it("calls edgeSearch with queryEmbedding and all excluded ids", async () => {
    const chunk = makeChunk({ vault_path: "a.md", score: 0.9 });
    const { store, embedder } = buildMocks([chunk]);
    const tools = buildRetrievalTools(store, embedder);

    await tools.sb_search({ query: "q", limit: 10 });

    expect(store.edgeSearch).toHaveBeenCalledOnce();
    const [embedding, limit] = (store.edgeSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(limit).toBe(1); // pool3Size = 10 - 7 - 2 = 1
  });

  it("calls updateNoveltyScores for all returned chunks", async () => {
    const chunk = makeChunk({ vault_path: "a.md", score: 0.9, content_type: "note" });
    const { store, embedder } = buildMocks([chunk]);
    const tools = buildRetrievalTools(store, embedder);

    await tools.sb_search({ query: "q", limit: 5 });

    expect(store.updateNoveltyScores).toHaveBeenCalledWith(
      expect.arrayContaining([{ id: chunk.id, content_type: "note" }])
    );
  });

  it("deduplicates pool1: keeps at most 2 results per vault_path", async () => {
    const chunks = [
      makeChunk({ vault_path: "notes/a.md", score: 0.95 }),
      makeChunk({ vault_path: "notes/a.md", score: 0.90 }),
      makeChunk({ vault_path: "notes/a.md", score: 0.85 }), // 3rd from same path -- dropped
      makeChunk({ vault_path: "notes/b.md", score: 0.70 }),
    ];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    // limit=10, pool1 can take up to 7 chunks
    const result = await tools.sb_search({ query: "q", limit: 10 });

    const fromA = result.chunks.filter((c: { vault_path: string }) => c.vault_path === "notes/a.md");
    expect(fromA).toHaveLength(2);
  });

  it("annotates results with pool number", async () => {
    const p1Chunk = makeChunk({ vault_path: "a.md", score: 0.9 });
    const p2Chunk = makeChunk({ vault_path: "b.md", novelty_score: 0.8, score: 0.8 });
    const p3Chunk = makeChunk({ vault_path: "c.md", score: 0.45 });

    const store = {
      hybridSearch: vi.fn().mockReturnValue([p1Chunk]),
      noveltySearch: vi.fn().mockReturnValue([p2Chunk]),
      edgeSearch: vi.fn().mockReturnValue([p3Chunk]),
      updateNoveltyScores: vi.fn(),
      filterByCompanion: vi.fn().mockReturnValue([]),
    } as unknown as VectorStore;
    const embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as unknown as Embedder;
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 10 });

    const pools = result.chunks.map((c: { pool: number }) => c.pool);
    expect(pools).toContain(1);
    expect(pools).toContain(2);
    expect(pools).toContain(3);
  });

  it("includes novelty_score in results", async () => {
    const chunk = makeChunk({ vault_path: "a.md", score: 0.9, novelty_score: 0.7 });
    const { store, embedder } = buildMocks([chunk]);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0].novelty_score).toBe(0.7);
  });

  it("prefers chunk_text over prefixed_text in output", async () => {
    const chunks = [
      makeChunk({ vault_path: "a.md", chunk_text: "display text", prefixed_text: "prefix: display text", score: 0.9 }),
    ];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0].text).toBe("display text");
  });

  it("falls back to prefixed_text when chunk_text is null", async () => {
    const chunk = makeChunk({ vault_path: "a.md", score: 0.9 });
    (chunk as unknown as Record<string, unknown>).chunk_text = null;
    chunk.prefixed_text = "prefixed fallback content";

    const { store, embedder } = buildMocks([chunk]);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0].text).toBe("prefixed fallback content");
  });

  it("returns correct shape: vault_path, text, section, score, novelty_score, pool", async () => {
    const chunks = [
      makeChunk({ vault_path: "notes/x.md", chunk_text: "chunk content", section: "Introduction", score: 0.88 }),
    ];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0]).toMatchObject({
      vault_path: "notes/x.md",
      text: "chunk content",
      section: "Introduction",
      score: 0.88,
      novelty_score: expect.any(Number),
      pool: 1,
    });
  });

  it("section defaults to empty string when null", async () => {
    const chunks = [makeChunk({ vault_path: "a.md", section: null, score: 0.5 })];
    const { store, embedder } = buildMocks(chunks);
    const tools = buildRetrievalTools(store, embedder);

    const result = await tools.sb_search({ query: "q", limit: 5 });

    expect(result.chunks[0].section).toBe("");
  });

  it("default limit is 10: hybridSearch called with pool1Size*5 = 35", async () => {
    const { store, embedder } = buildMocks([]);
    const tools = buildRetrievalTools(store, embedder);

    await tools.sb_search({ query: "q" });

    const [, , limit] = (store.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    // pool1Size = Math.round(10 * 0.7) = 7, oversample = 7 * 5 = 35
    expect(limit).toBe(35);
  });
});
