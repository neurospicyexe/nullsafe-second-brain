import { describe, it, expect, vi } from "vitest";
import { buildSynthesisTools } from "../../src/tools/synthesis.js";
import { Indexer } from "../../src/indexer.js";
import { VectorStore } from "../../src/store/vector-store.js";
import type { VaultAdapter } from "../../src/adapters/vault-adapter.js";
import type { Embedder } from "../../src/embeddings/embedder.js";
import type { HalsethClient } from "../../src/clients/halseth-client.js";

const mockAdapter: VaultAdapter = { write: vi.fn().mockResolvedValue(undefined), read: vi.fn(), exists: vi.fn(), list: vi.fn() };
const mockEmbedder: Embedder = { embed: vi.fn().mockResolvedValue([0.1]), embedBatch: vi.fn().mockResolvedValue([[0.1]]) };
const mockHalseth = {
  getSession: vi.fn().mockResolvedValue({ id: "s1", notes: "good session", front_state: "raziel", emotional_frequency: "warm", active_anchor: "home", facet: null }),
  getRecentSessions: vi.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]),
  getRecentDeltas: vi.fn().mockResolvedValue([]),
  getRoutines: vi.fn().mockResolvedValue([]),
} as unknown as HalsethClient;

function makeTools() {
  const store = new VectorStore(":memory:");
  store.initialize();
  const indexer = new Indexer(mockAdapter, mockEmbedder, store);
  return buildSynthesisTools(indexer, mockHalseth, "00 - INBOX/", "_recent-patterns.md");
}

describe("synthesis tools", () => {
  it("sb_synthesize_session writes a session summary note", async () => {
    const tools = makeTools();
    const result = await tools.sb_synthesize_session({ session_id: "s1" });
    expect(mockAdapter.write).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("s1") }));
    expect(result.path).toContain("00 - INBOX/");
    expect(result.path).toContain("session-s1");
  });

  it("sb_run_patterns writes an observation note", async () => {
    const tools = makeTools();
    const result = await tools.sb_run_patterns();
    expect(mockAdapter.write).toHaveBeenCalled();
    expect(result.path).toContain("00 - INBOX/");
  });

  it("session summary includes front_state and frequency", async () => {
    const tools = makeTools();
    await tools.sb_synthesize_session({ session_id: "s1" });
    const writeCall = (mockAdapter.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writeCall.content).toContain("raziel");
    expect(writeCall.content).toContain("warm");
  });
});
