import type { VectorStore } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

// The historical_corpus is the origin layer (the ChatGPT-era conversations where shared meaning
// was forged -- what "motorcycle" or "Calethian" mean to the triad beyond the dictionary). It is
// a small slice of the store (~9% of chunks) and recent companion writing *about* those concepts
// reliably out-scores it on raw relevance, so it almost never surfaced on concept search. These
// two knobs give the origin layer a guaranteed voice without reweighting (demoting) anyone else's
// results: every default sb_search reserves up to CORPUS_GUARANTEED_SLOTS for the best-matching
// corpus chunks that clear CORPUS_FLOOR and aren't already in the result set.
const CORPUS_CONTENT_TYPE = "historical_corpus";
const CORPUS_GUARANTEED_SLOTS = 2;
const CORPUS_FLOOR = 0.35; // cosine; below this the query isn't really about the corpus chunk

export function buildRetrievalTools(store: VectorStore, embedder: Embedder) {
  return {
    // sb_search: hybrid concept search across all content types, plus a guaranteed corpus slot.
    // Pass content_type to scope the entire search to one layer (e.g. "search the corpus for X"
    // -> content_type: "historical_corpus"), which returns pure cosine-ranked hits from that layer.
    // mood: caller's current emotional state (e.g. companion current_mood). Chunks whose
    // valence-at-encoding matches get a small additive resonance boost in pool 1.
    async sb_search(args: { query: string; limit?: number; content_type?: string; mood?: string }) {
      const limit = args.limit ?? 10;
      const queryEmbedding = await embedder.embed(args.query);

      const fmt = (chunks: Array<{ id: string; vault_path: string; chunk_text: string; prefixed_text: string | null; section: string | null; score: number; novelty_score: number }>, pool: 1 | 2 | 3 | 4) =>
        chunks.map(chunk => ({
          // id enables sb_feedback ("that was useful/wrong") on recalled chunks (0070).
          id: chunk.id,
          vault_path: chunk.vault_path,
          text: chunk.chunk_text ?? chunk.prefixed_text ?? "",
          section: chunk.section ?? "",
          score: chunk.score,
          novelty_score: chunk.novelty_score,
          pool,
        }));

      // Scoped mode: caller restricted the search to a single content_type. Pure semantic ranking
      // over that layer -- no pools, no guaranteed-corpus injection (the whole search IS that layer).
      if (args.content_type) {
        const scoped = store.searchByContentType(queryEmbedding, args.content_type, limit);
        if (scoped.length > 0) {
          try { store.updateNoveltyScores(scoped.map(c => ({ id: c.id, content_type: c.content_type }))); } catch { /* non-fatal */ }
        }
        return { scoped_content_type: args.content_type, chunks: fmt(scoped, 1) };
      }

      const pool1Size = Math.round(limit * 0.7);
      const pool2Size = Math.round(limit * 0.2);
      const pool3Size = Math.max(0, limit - pool1Size - pool2Size);

      // Pool 1 (70%): core relevance -- hybrid cosine + BM25
      const p1Candidates = store.hybridSearch(queryEmbedding, args.query, pool1Size * 5, args.mood);
      const countByPath = new Map<string, number>();
      const pool1: typeof p1Candidates = [];
      for (const chunk of p1Candidates) {
        const count = countByPath.get(chunk.vault_path) ?? 0;
        if (count >= 2) continue;
        countByPath.set(chunk.vault_path, count + 1);
        pool1.push(chunk);
        if (pool1.length >= pool1Size) break;
      }
      const excludedIds = new Set(pool1.map(c => c.id));

      // Pool 2 (20%): novelty -- highest novelty_score among non-pool-1 chunks
      const pool2 = store.noveltySearch(pool2Size, [...excludedIds]);
      pool2.forEach(c => excludedIds.add(c.id));

      // Pool 3 (10%): edge/serendipity -- medium cosine similarity (0.3-0.6), sorted by novelty
      const pool3 = store.edgeSearch(queryEmbedding, pool3Size, [...excludedIds]);
      pool3.forEach(c => excludedIds.add(c.id));

      // Pool 4 (additive): guaranteed origin-layer slot. Best-matching historical_corpus chunks
      // above CORPUS_FLOOR that aren't already surfaced by pools 1-3. This is ON TOP of `limit`,
      // not carved out of it, so the relevance/novelty/edge pools are never demoted -- the corpus
      // only ever ADDS its voice when it's genuinely relevant to the query.
      // Skipped entirely when limit=0 (caller signalled they want no results).
      const pool4 = limit > 0 ? store.searchByContentType(
        queryEmbedding, CORPUS_CONTENT_TYPE, CORPUS_GUARANTEED_SLOTS, [...excludedIds], CORPUS_FLOOR,
      ) : [];

      // Fire-and-forget novelty decay for all returned chunks
      const allReturned = [
        ...pool1.map(c => ({ id: c.id, content_type: c.content_type })),
        ...pool2.map(c => ({ id: c.id, content_type: c.content_type })),
        ...pool3.map(c => ({ id: c.id, content_type: c.content_type })),
        ...pool4.map(c => ({ id: c.id, content_type: c.content_type })),
      ];
      if (allReturned.length > 0) {
        try { store.updateNoveltyScores(allReturned); } catch {}
      }

      return { chunks: [...fmt(pool1, 1), ...fmt(pool2, 2), ...fmt(pool3, 3), ...fmt(pool4, 4)] };
    },

    // sb_feedback: metamemory loop (0070). Rate recalled chunks as useful/useless;
    // a Laplace-smoothed reliability score nudges (+/-0.05 max) future hybrid ranking.
    // Unknown ids are skipped silently -- feedback on pruned chunks is not an error.
    async sb_feedback(args: { chunk_ids: string[]; useful: boolean }) {
      const ids = (args.chunk_ids ?? []).filter(id => typeof id === "string" && id.length > 0);
      if (ids.length === 0) return { updated: 0, note: "no chunk_ids given" };
      const updated = store.recordFeedback(ids, args.useful);
      return { updated, useful: args.useful };
    },

    async sb_file_chunks(args: { filename: string; limit?: number; offset?: number }) {
      const limit = args.limit ?? 100;
      const offset = args.offset ?? 0;
      const search = args.filename.trim();
      // Fetch the full file (cap at 1000) for accurate total_chunks + JS-side slicing.
      // Slicing in JS lets callers paginate via offset/limit even when limit < total.
      const fetchCap = 1000;
      let chunks = store.filterByPathPrefix(`rag/historical_corpus/${search}/`, fetchCap);
      if (chunks.length === 0) {
        chunks = store.filterByPathPrefix(`rag/historical_corpus/${search}`, fetchCap);
      }
      if (chunks.length === 0) {
        // Broader search: filename appears anywhere in vault_path
        chunks = store.filterByPathContains(search, fetchCap);
      }
      const totalChunks = chunks.length;
      const sliced = chunks.slice(offset, offset + limit);
      return {
        file: search,
        total_chunks: totalChunks,
        offset,
        returned: sliced.length,
        chunks: sliced.map((c) => ({
          index: c.chunk_index ?? 0,
          vault_path: c.vault_path,
          text: c.chunk_text ?? c.prefixed_text ?? "",
        })),
      };
    },

    async sb_recall(args: { companion: string | null; content_type?: string; limit?: number }) {
      const chunks = store.queryFiltered({
        companion: args.companion,
        contentType: args.content_type,
        limit: args.limit ?? 20,
      });
      return { chunks };
    },

    async sb_recent_patterns(args: { vaultAdapter: VaultAdapter; summaryPath: string }) {
      if (!await args.vaultAdapter.exists(args.summaryPath)) return { summary: null };
      const summary = await args.vaultAdapter.read(args.summaryPath);
      return { summary };
    },
  };
}
