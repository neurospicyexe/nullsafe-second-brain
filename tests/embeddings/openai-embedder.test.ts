import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIEmbedder } from "../../src/embeddings/openai-embedder.js";

describe("OpenAIEmbedder", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    }) as unknown as typeof fetch;
  });

  it("returns an embedding vector for a string", async () => {
    const embedder = new OpenAIEmbedder({ model: "text-embedding-3-small", apiKey: "sk-test" });
    const result = await embedder.embed("hello world");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("calls OpenAI with correct headers and body", async () => {
    const embedder = new OpenAIEmbedder({ model: "text-embedding-3-small", apiKey: "sk-test" });
    await embedder.embed("test");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Authorization": "Bearer sk-test" }),
      })
    );
  });

  it("embedBatch returns multiple vectors", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }, { embedding: [0.2] }] }),
    });
    const embedder = new OpenAIEmbedder({ model: "text-embedding-3-small", apiKey: "sk-test" });
    const result = await embedder.embedBatch(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1]);
    expect(result[1]).toEqual([0.2]);
  });

  it("throws on non-ok response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "invalid api key",
    });
    const embedder = new OpenAIEmbedder({ model: "text-embedding-3-small", apiKey: "bad-key" });
    await expect(embedder.embed("test")).rejects.toThrow("OpenAI embeddings error");
  });
});
