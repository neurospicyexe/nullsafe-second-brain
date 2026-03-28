import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCaptureTools } from "../../src/tools/capture.js";
import { VectorStore } from "../../src/store/vector-store.js";
import { Indexer } from "../../src/indexer.js";
import { RouteResolver } from "../../src/router.js";
import type { VaultAdapter } from "../../src/adapters/vault-adapter.js";
import type { Embedder } from "../../src/embeddings/embedder.js";

const mockAdapter: VaultAdapter = {
  write: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue("content"),
  exists: vi.fn().mockResolvedValue(false),
  list: vi.fn().mockResolvedValue([]),
};
const mockEmbedder: Embedder = {
  embed: vi.fn().mockResolvedValue([0.1]),
  embedBatch: vi.fn().mockResolvedValue([[0.1]]),
};

function makeTools() {
  const store = new VectorStore(":memory:");
  store.initialize();
  const indexer = new Indexer(mockAdapter, mockEmbedder, store);
  const resolver = new RouteResolver([
    { type: "observation", destination: "00 - INBOX/" },
    { type: "document", destination: "Docs/" },
  ]);
  return { tools: buildCaptureTools(indexer, resolver), store };
}

describe("capture tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sb_save_document writes verbatim content", async () => {
    const { tools } = makeTools();
    const result = await tools.sb_save_document({ path: "Creative/story.md", content: "Once upon a time...", companion: "companion-a", tags: ["story"] });
    expect(mockAdapter.write).toHaveBeenCalledWith(expect.objectContaining({ content: "Once upon a time..." }));
    expect(result.path).toBe("Creative/story.md");
  });

  it("sb_save_document uses routing when no explicit path", async () => {
    const { tools } = makeTools();
    const result = await tools.sb_save_document({ content: "A doc", tags: [] });
    expect(result.path).toContain("Docs/");
  });

  it("sb_save_document returns the written path", async () => {
    const { tools } = makeTools();
    const result = await tools.sb_save_document({ content: "# Note", tags: [] });
    expect(result.path).toBeTruthy();
  });

  it("sb_save_study uses subject in path", async () => {
    const { tools } = makeTools();
    const result = await tools.sb_save_study({ content: "Bloom taxonomy", subject: "ABCTE/Pedagogy" });
    expect(result.path).toContain("ABCTE/Pedagogy");
  });

  it("sb_log_observation routes to INBOX", async () => {
    const { tools } = makeTools();
    const result = await tools.sb_log_observation({ content: "Pattern detected" });
    expect(result.path).toContain("00 - INBOX/");
  });

  it("sb_log_observation never writes directly to permanent folders", async () => {
    const { tools } = makeTools();
    const result = await tools.sb_log_observation({ content: "obs", tags: [] });
    expect(result.path).not.toContain("GALAXY");
    expect(result.path).not.toContain("Companions");
  });
});
