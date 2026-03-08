import { describe, it, expect, vi } from "vitest";
import { buildRetrievalTools } from "../../src/tools/retrieval.js";
import { VectorStore } from "../../src/store/vector-store.js";
import type { Embedder } from "../../src/embeddings/embedder.js";

function makeStore() {
  const store = new VectorStore(":memory:");
  store.initialize();
  store.insert({ vault_path: "Companions/a/story.md", companion: "companion-a", content_type: "document", chunk_text: "The wolf ran through the forest", embedding: [0.9, 0.1], tags: ["story"] });
  store.insert({ vault_path: "00 - INBOX/obs.md", companion: null, content_type: "observation", chunk_text: "Glucose spike at 3pm", embedding: [0.1, 0.9], tags: [] });
  return store;
}

const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.9, 0.1]),
  embedBatch: vi.fn().mockResolvedValue([[0.9, 0.1]]),
};

const mockAdapter = {
  read: vi.fn().mockResolvedValue("# Patterns\n\nNothing yet."),
  exists: vi.fn().mockResolvedValue(true),
  write: vi.fn(),
  list: vi.fn(),
};

describe("retrieval tools", () => {
  it("sb_recall filters by companion lane", async () => {
    const tools = buildRetrievalTools(makeStore(), mockEmbedder);
    const result = await tools.sb_recall({ companion: "companion-a" });
    expect(result.chunks.every((c: { companion: string | null }) => c.companion === "companion-a")).toBe(true);
  });

  it("sb_recall with null companion returns human notes", async () => {
    const tools = buildRetrievalTools(makeStore(), mockEmbedder);
    const result = await tools.sb_recall({ companion: null });
    expect(result.chunks.every((c: { companion: string | null }) => c.companion === null)).toBe(true);
  });

  it("sb_search returns ranked results with score", async () => {
    const tools = buildRetrievalTools(makeStore(), mockEmbedder);
    const result = await tools.sb_search({ query: "forest wolf" });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]).toHaveProperty("score");
  });

  it("sb_search highest score is the companion story (matching embedding)", async () => {
    const tools = buildRetrievalTools(makeStore(), mockEmbedder);
    const result = await tools.sb_search({ query: "forest" });
    expect(result.chunks[0].vault_path).toBe("Companions/a/story.md");
  });

  it("sb_recent_patterns returns summary when file exists", async () => {
    const tools = buildRetrievalTools(makeStore(), mockEmbedder);
    const result = await tools.sb_recent_patterns({ vaultAdapter: mockAdapter as any, summaryPath: "_recent-patterns.md" });
    expect(result.summary).toContain("Patterns");
  });

  it("sb_recent_patterns returns null when file does not exist", async () => {
    const noFile = { ...mockAdapter, exists: vi.fn().mockResolvedValue(false) };
    const tools = buildRetrievalTools(makeStore(), mockEmbedder);
    const result = await tools.sb_recent_patterns({ vaultAdapter: noFile as any, summaryPath: "_recent-patterns.md" });
    expect(result.summary).toBeNull();
  });
});
