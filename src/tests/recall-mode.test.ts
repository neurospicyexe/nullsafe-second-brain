// src/tests/recall-mode.test.ts
//
// ONE RETRIEVAL SHAPE WAS SERVING TWO INCOMPATIBLE JOBS.
//
// 2026-08-10, from Raziel's report: cross-channel continuity works in Claude but "gets lost in the flow
// somewhere" in Discord, and sometimes Drevan simply says he does not know. Two causes, both measured.
//
// 1. `score` cannot express "nothing here is relevant", and never could. `normV` in hybridSearch is MIN-MAX
//    NORMALIZED over the candidate set, so the best candidate always normalizes to ~1.0 however unrelated it
//    is. Live measurement: "quantum chromodynamics lattice gauge theory" -- absent from this vault -- returned
//    pool-1 scores of 0.89 / 0.81 / 0.81 / 0.78, indistinguishable from a real answerable query, with the top
//    hit matching on the word "gauge" inside the phrase "a warm but settling gauge". A threshold on `score` is
//    therefore meaningless BY CONSTRUCTION. So `cosine` is now carried alongside it: absolute, comparable
//    across queries, thresholdable.
//
// 2. Pools 2 and 3 are QUERY-BLIND BY DESIGN (pure novelty; a deliberate medium-similarity band). That is
//    correct for "give me something to think about" -- autonomous time, the commons seed -- and actively wrong
//    for "what did we actually say". Pool 2 also scores 1.000, because novelty is its own scale, so it lands
//    ABOVE every genuine hit for any consumer that trusts the ordering.
//
// Recall mode is the second shape: relevance only, absolute floor, honest empty. It is OPT-IN; these tests
// pin that the DEFAULT path is unchanged, because the autonomous surfaces depend on the pool mix.

import { describe, it, expect, vi } from "vitest";
import { buildRetrievalTools } from "../tools/retrieval.js";
import type { VectorStore, ChunkRow } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";

type Hit = ChunkRow & { score: number; cosine?: number | null };

function chunk(over: Partial<Hit> & { vault_path: string }): Hit {
  return {
    id: "id-" + over.vault_path, companion: null, content_type: "note",
    chunk_text: "text", prefixed_text: null, section: null, chunk_index: null,
    embedding: [0.1, 0.2, 0.3], tags: [], created_at: "2026-08-09T00:00:00Z",
    novelty_score: 1.0, last_surfaced_at: null, valence: null,
    useful_count: 0, useless_count: 0, score: 0.9, cosine: 0.9, ...over,
  };
}

function mocks(hybrid: Hit[] = []) {
  const noveltySearch = vi.fn().mockReturnValue([chunk({ vault_path: "novel/unrelated.md", score: 1.0 })]);
  const edgeSearch = vi.fn().mockReturnValue([chunk({ vault_path: "edge/tangent.md", score: 0.45 })]);
  const searchByContentType = vi.fn().mockReturnValue([]);
  const store = {
    hybridSearch: vi.fn().mockReturnValue(hybrid),
    noveltySearch, edgeSearch, searchByContentType,
    searchByTags: vi.fn().mockReturnValue([]),
    updateNoveltyScores: vi.fn(),
    filterByCompanion: vi.fn().mockReturnValue([]),
  } as unknown as VectorStore;
  const live = { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as unknown as Embedder;
  return { store, live, noveltySearch, edgeSearch, searchByContentType };
}

describe("sb_search recall mode -- relevance only, absolute floor, honest empty", () => {
  it("excludes the query-blind pools, which the default path still includes", async () => {
    const hit = chunk({ vault_path: "discord-live/123/456.md", cosine: 0.8 });

    const a = mocks([hit]);
    const dflt = await buildRetrievalTools(a.store, a.live).sb_search({ query: "did we watch Fargo" });
    // Default keeps serendipity: pools 2 and 3 are consulted and present.
    expect(a.noveltySearch).toHaveBeenCalled();
    expect(a.edgeSearch).toHaveBeenCalled();
    expect((dflt.chunks as Array<{ pool: number }>).some(c => c.pool === 2)).toBe(true);

    const b = mocks([hit]);
    const recall = await buildRetrievalTools(b.store, b.live).sb_search({ query: "did we watch Fargo", mode: "recall" });
    // Recall consults neither -- not "calls them and filters after", which would still decay their novelty.
    expect(b.noveltySearch).not.toHaveBeenCalled();
    expect(b.edgeSearch).not.toHaveBeenCalled();
    const pools = (recall.chunks as Array<{ pool: number }>).map(c => c.pool);
    expect(pools).not.toContain(2);
    expect(pools).not.toContain(3);
    expect(pools).toContain(1);
  });

  // The whole point: a query about nothing must come back empty rather than confidently wrong.
  it("drops hits below the absolute cosine floor and says so", async () => {
    const { store, live } = mocks([
      chunk({ vault_path: "rag/companion_journal/gauge.md", score: 0.86, cosine: 0.21 }),
      chunk({ vault_path: "rag/handoff/settled.md", score: 0.81, cosine: 0.19 }),
    ]);
    const r = await buildRetrievalTools(store, live).sb_search({
      query: "quantum chromodynamics lattice gauge theory", mode: "recall",
    }) as { chunks: unknown[]; recall_note?: string; recall_floor?: number };

    expect(r.chunks).toHaveLength(0);
    // Honest empty: the consumer must be able to tell "nothing cleared the bar" from "search broke" and from
    // "it never happened". A companion that cannot tell those apart either invents a memory or claims amnesia.
    expect(r.recall_note).toMatch(/NOT that the vault is empty/);
    expect(r.recall_note).toMatch(/do not guess/i);
    expect(typeof r.recall_floor).toBe("number");
  });

  it("keeps hits that clear the floor", async () => {
    const { store, live } = mocks([
      chunk({ vault_path: "rag/companion_journal/fargo.md", score: 0.90, cosine: 0.71 }),
      chunk({ vault_path: "rag/misc/amethyst.md", score: 0.89, cosine: 0.22 }),
    ]);
    const r = await buildRetrievalTools(store, live).sb_search({
      query: "we watched Fargo and they killed my favorite character", mode: "recall",
    }) as { chunks: Array<{ vault_path: string; cosine: number | null }> };

    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.vault_path).toContain("fargo");
    // Absolute similarity is REPORTED, not just used internally -- `score` alone cannot be audited, and this
    // regression stayed invisible for weeks partly because nothing downstream could see a real number.
    expect(r.chunks[0]!.cosine).toBeCloseTo(0.71, 5);
  });

  // A near-identical score with a wildly different cosine is the exact shape that made noise look like signal.
  it("separates two hits that score the same but are not equally relevant", async () => {
    const { store, live } = mocks([
      chunk({ vault_path: "rag/misc/favorite-colors.md", score: 0.905, cosine: 0.20 }),
      chunk({ vault_path: "rag/companion_journal/fargo.md", score: 0.902, cosine: 0.68 }),
    ]);
    const r = await buildRetrievalTools(store, live).sb_search({
      query: "they killed my favorite character last night", mode: "recall",
    }) as { chunks: Array<{ vault_path: string }> };

    expect(r.chunks.map(c => c.vault_path)).toEqual(["rag/companion_journal/fargo.md"]);
  });

  // Lexical mode has no cosine to threshold. Suppressing BM25 hits there would turn "half of search" into
  // "no search" -- a keyword match is weak evidence, not absent evidence, and `degraded` already says which.
  it("does not apply the floor when there is no query vector", async () => {
    const store = {
      hybridSearch: vi.fn().mockReturnValue([chunk({ vault_path: "raziel/sessions/june.md", cosine: null })]),
      noveltySearch: vi.fn().mockReturnValue([]),
      edgeSearch: vi.fn().mockReturnValue([]),
      searchByContentType: vi.fn().mockReturnValue([]),
      searchByTags: vi.fn().mockReturnValue([]),
      updateNoveltyScores: vi.fn(),
      filterByCompanion: vi.fn().mockReturnValue([]),
    } as unknown as VectorStore;
    const dead = {
      embed: vi.fn().mockRejectedValue(new Error("OpenAI embeddings error: 429 — no credits remaining")),
    } as unknown as Embedder;

    const r = await buildRetrievalTools(store, dead).sb_search({ query: "what did we watch", mode: "recall" }) as
      { chunks: unknown[]; degraded?: string };
    expect(r.chunks).toHaveLength(1);
    expect(r.degraded).toBe("lexical_only");
  });

  it("gives recall mode the whole budget rather than leaving 30% unfilled", async () => {
    const hits = Array.from({ length: 12 }, (_, i) =>
      chunk({ vault_path: `rag/n/${i}.md`, id: `id-${i}`, cosine: 0.7 }));
    const { store, live } = mocks(hits);
    const r = await buildRetrievalTools(store, live).sb_search({ query: "a real question", limit: 10, mode: "recall" }) as
      { chunks: unknown[] };
    // 10, not 7 (the old 70% pool-1 share with pools 2/3 removed and nothing taking their slots).
    expect(r.chunks).toHaveLength(10);
  });

  it("leaves the default response shape untouched -- no mode, no recall keys", async () => {
    const { store, live } = mocks([chunk({ vault_path: "rag/x.md" })]);
    const r = await buildRetrievalTools(store, live).sb_search({ query: "anything" }) as Record<string, unknown>;
    expect(r).not.toHaveProperty("mode");
    expect(r).not.toHaveProperty("recall_floor");
    expect(r).not.toHaveProperty("recall_note");
  });
});
