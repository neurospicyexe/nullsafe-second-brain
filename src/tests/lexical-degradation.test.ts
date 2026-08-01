// src/tests/lexical-degradation.test.ts
//
// THE EMBEDDER MUST NOT BE ABLE TO TAKE THE WHOLE VAULT WITH IT.
//
// 2026-08-01: OpenAI ran out of credits. `sb_search` began with an unguarded
// `await embedder.embed(args.query)`, so it threw on its first line and every companion lost access to ALL of
// the long-term memory for the duration of a BILLING problem -- while FTS5/BM25, which is local, free, and
// already built over the same corpus, needed no query vector at all. On the substrate that holds all the
// history, availability is the property that matters most.
//
// The rule these tests pin: a dead embedder costs the SEMANTIC half of search and nothing else, it is
// DECLARED in the payload, and it never invents results it cannot rank.

import { describe, it, expect, vi } from "vitest";
import { buildRetrievalTools } from "../tools/retrieval.js";
import { buildSystemTools } from "../tools/system.js";
import type { VectorStore, ChunkRow } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

const QUOTA_ERROR = new Error("OpenAI embeddings error: 429 Too Many Requests — You have no credits remaining.");

function chunk(over: Partial<ChunkRow & { score: number }> & { vault_path: string }): ChunkRow & { score: number } {
  return {
    id: "id-" + over.vault_path, companion: null, content_type: "note",
    chunk_text: "text", prefixed_text: null, section: null, chunk_index: null,
    embedding: [0.1, 0.2, 0.3], tags: [], created_at: "2026-01-01T00:00:00Z",
    novelty_score: 1.0, last_surfaced_at: null, valence: null,
    useful_count: 0, useless_count: 0, score: 0.5, ...over,
  };
}

function mocks(hybrid: Array<ChunkRow & { score: number }> = []) {
  const store = {
    hybridSearch: vi.fn().mockReturnValue(hybrid),
    noveltySearch: vi.fn().mockReturnValue([]),
    edgeSearch: vi.fn().mockReturnValue([]),
    searchByContentType: vi.fn().mockReturnValue([]),
    searchByTags: vi.fn().mockReturnValue([]),
    updateNoveltyScores: vi.fn(),
    filterByCompanion: vi.fn().mockReturnValue([]),
  } as unknown as VectorStore;
  const dead = { embed: vi.fn().mockRejectedValue(QUOTA_ERROR) } as unknown as Embedder;
  const live = { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as unknown as Embedder;
  return { store, dead, live };
}

describe("sb_search -- degrades to lexical when the embedder is down", () => {
  it("still returns keyword results instead of throwing", async () => {
    const { store, dead } = mocks([chunk({ vault_path: "raziel/sessions/june.md" })]);
    const tools = buildRetrievalTools(store, dead);

    const r = await tools.sb_search({ query: "fargo episode", limit: 5 });

    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0].vault_path).toBe("raziel/sessions/june.md");
  });

  it("passes NULL to hybridSearch -- not a zero vector, which would fake similarity", async () => {
    const { store, dead } = mocks([chunk({ vault_path: "a.md" })]);
    await buildRetrievalTools(store, dead).sb_search({ query: "q", limit: 5 });

    expect(store.hybridSearch).toHaveBeenCalled();
    expect(vi.mocked(store.hybridSearch).mock.calls[0][0]).toBeNull();
  });

  it("DECLARES the degradation in the payload, not just the log", async () => {
    const { store, dead } = mocks([chunk({ vault_path: "a.md" })]);
    const r = await buildRetrievalTools(store, dead).sb_search({ query: "q", limit: 5 });

    // A keyword-only search presenting itself as full recall is how a companion concludes something is not
    // in the vault when it is.
    expect(r.degraded).toBe("lexical_only");
    // `in` narrows the scoped/unscoped union; degraded_note only exists on the unscoped return.
    expect("degraded_note" in r && String(r.degraded_note)).toContain("does NOT mean absence from the vault");
  });

  it("SKIPS the cosine-defined pools rather than sampling arbitrarily", async () => {
    const { store, dead } = mocks([chunk({ vault_path: "a.md" })]);
    await buildRetrievalTools(store, dead).sb_search({ query: "q", limit: 10 });

    // pool 3 is a cosine BAND and pool 4 gates on a cosine FLOOR; neither is meaningful with no query vector.
    expect(store.edgeSearch).not.toHaveBeenCalled();
    expect(store.searchByContentType).not.toHaveBeenCalled();
    // pool 2 (novelty) needs no vector, so it must still run -- degrade, don't amputate.
    expect(store.noveltySearch).toHaveBeenCalled();
  });

  it("healthy path is unchanged: no degraded field, all pools run", async () => {
    const { store, live } = mocks([chunk({ vault_path: "a.md" })]);
    const r = await buildRetrievalTools(store, live).sb_search({ query: "q", limit: 10 });

    expect(r.degraded).toBeUndefined();
    expect(vi.mocked(store.hybridSearch).mock.calls[0][0]).toEqual([0.1, 0.2, 0.3]);
    expect(store.edgeSearch).toHaveBeenCalled();
    expect(store.searchByContentType).toHaveBeenCalled();
  });

  it("scoped search still answers, narrowed to the requested layer", async () => {
    const { store, dead } = mocks([
      chunk({ vault_path: "corpus/a.md", content_type: "historical_corpus" }),
      chunk({ vault_path: "note/b.md", content_type: "note" }),
    ]);
    const r = await buildRetrievalTools(store, dead).sb_search({
      query: "calethian", limit: 5, content_type: "historical_corpus",
    });

    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0].vault_path).toBe("corpus/a.md");
    expect(r.degraded).toBe("lexical_only");
  });
});

describe("sb_read -- a vault read never depends on a funded API key", () => {
  // buildSystemTools(store, indexer, adapter, embedder) -- FOUR args, embedder LAST. Getting this wrong made
  // `embedder` arrive undefined, so `embedder.embed` threw a TypeError that the new try/catch swallowed and
  // two of the tests above passed for entirely the wrong reason. Pin the real signature.
  function sys(embedder: Embedder, chunks: Array<ChunkRow & { score: number }>) {
    const store = { filterByPath: vi.fn().mockReturnValue(chunks) } as unknown as VectorStore;
    const adapter = {
      read: vi.fn().mockResolvedValue("# The whole file\n\nevery section of it"),
      list: vi.fn(), write: vi.fn(), move: vi.fn(), exists: vi.fn(),
    } as unknown as VaultAdapter;
    const indexer = { write: vi.fn(), reindex: vi.fn() } as unknown as Parameters<typeof buildSystemTools>[1];
    return { tools: buildSystemTools(store, indexer, adapter, embedder), adapter };
  }

  it("returns the FULL FILE rather than excerpts chosen by a dead ranker", async () => {
    const { dead } = mocks();
    const { tools, adapter } = sys(dead, [chunk({ vault_path: "p.md" })]);

    const r = await tools.sb_read({ path: "p.md", query: "what happened" }) as Record<string, unknown>;

    expect(adapter.read).toHaveBeenCalledWith("p.md");
    expect(r.content).toContain("every section of it");
    // Excerpt mode is PURE cosine, so three "most relevant" excerpts would be three arbitrary ones.
    expect(r.mode).toBeUndefined();
    expect(r.degraded).toBe("full_file_no_ranker");
  });

  it("a plain read (no query) never touches the embedder at all", async () => {
    const { dead } = mocks();
    const { tools } = sys(dead, [chunk({ vault_path: "p.md" })]);

    const r = await tools.sb_read({ path: "p.md" }) as Record<string, unknown>;

    expect(r.content).toContain("every section of it");
    expect(r.degraded).toBeUndefined();
    expect(vi.mocked(dead.embed)).not.toHaveBeenCalled();
  });

  it("healthy excerpt mode still ranks by cosine", async () => {
    const { live } = mocks();
    const { tools } = sys(live, [chunk({ vault_path: "p.md", chunk_text: "the relevant bit" })]);

    const r = await tools.sb_read({ path: "p.md", query: "q" }) as Record<string, unknown>;

    expect(r.mode).toBe("excerpts");
    expect(r.degraded).toBeUndefined();
  });
});
