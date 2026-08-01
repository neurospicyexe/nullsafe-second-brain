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
    // mood: caller's current emotional state (e.g. companion current_mood). In pool 1, chunks get a
    // graded additive resonance boost by emotion-space distance (valence x arousal) to that mood --
    // closer affect ranks higher. See store/emotion-space.ts. Never gates recall.
    async sb_search(args: { query: string; limit?: number; content_type?: string; mood?: string }) {
      const limit = args.limit ?? 10;

      // THE EMBEDDER IS NOT ALLOWED TO TAKE THE WHOLE VAULT WITH IT (2026-08-01).
      //
      // This was `await embedder.embed(args.query)` as the first statement, unguarded. When OpenAI ran out of
      // credits the embedder threw, sb_search threw, and every companion lost access to ALL of the long-term
      // memory -- for as long as the billing problem lasted. Meanwhile FTS5/BM25 is local, free, already built
      // over the same corpus, and needs no query vector at all.
      //
      // So: degrade to lexical, never die. Semantic recall is the thing the embedder owns; keyword recall over
      // the history is not, and this is the substrate where "all the history is in there" makes availability
      // the property that matters most.
      let queryEmbedding: number[] | null = null;
      try {
        queryEmbedding = await embedder.embed(args.query);
      } catch (err) {
        console.error(`[sb_search] embedder unavailable, degrading to lexical-only: ${(err as Error).message}`);
      }
      // Surfaced in the RESPONSE, not just the log. A keyword-only search that presents itself as full recall
      // is how a companion concludes something is not in the vault when it is -- the same class of error as
      // answering a "where are we in the show" question from whatever prose ranked highest.
      const degraded = queryEmbedding ? undefined : ("lexical_only" as const);

      const fmt = (chunks: Array<{ id: string; vault_path: string; chunk_text: string; prefixed_text: string | null; section: string | null; score: number; novelty_score: number; created_at?: string }>, pool: 1 | 2 | 3 | 4) =>
        chunks.map(chunk => ({
          // id enables sb_feedback ("that was useful/wrong") on recalled chunks (0070).
          id: chunk.id,
          vault_path: chunk.vault_path,
          text: chunk.chunk_text ?? chunk.prefixed_text ?? "",
          section: chunk.section ?? "",
          score: chunk.score,
          novelty_score: chunk.novelty_score,
          // WHEN (2026-07-31). Omitted until now, so every consumer -- including the Discord bots'
          // per-message recall -- received chunks it could not place in time and had no way to tell a
          // June summary from last night's note. Ranking by recency is useless if the consumer still
          // cannot SEE the date: the model has to be able to say "that was six weeks ago" rather than
          // treating every fragment as equally current.
          created_at: chunk.created_at ?? null,
          pool,
        }));

      // Scoped mode: caller restricted the search to a single content_type. Pure semantic ranking
      // over that layer -- no pools, no guaranteed-corpus injection (the whole search IS that layer).
      if (args.content_type) {
        // Lexical mode: searchByContentType ranks purely by cosine, so it has nothing to rank with. Fall back
        // to a lexical pass over everything, then keep only the requested layer -- narrower than the real
        // scoped search, but it still answers "is this in the corpus" instead of refusing.
        const scoped = queryEmbedding
          ? store.searchByContentType(queryEmbedding, args.content_type, limit)
          : store.hybridSearch(null, args.query, limit * 10)
              .filter(c => c.content_type === args.content_type)
              .slice(0, limit);
        if (scoped.length > 0) {
          try { store.updateNoveltyScores(scoped.map(c => ({ id: c.id, content_type: c.content_type }))); } catch { /* non-fatal */ }
        }
        return { scoped_content_type: args.content_type, chunks: fmt(scoped, 1), ...(degraded ? { degraded } : {}) };
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

      // Pool 3 (10%): edge/serendipity -- medium cosine similarity (0.3-0.6), sorted by novelty.
      // SKIPPED in lexical mode: this pool is DEFINED by a cosine band, so without a query vector there is no
      // such thing as "medium similarity". Passing a zero vector would make every chunk equidistant and turn
      // serendipity into an arbitrary sample dressed as a finding.
      const pool3 = queryEmbedding ? store.edgeSearch(queryEmbedding, pool3Size, [...excludedIds]) : [];
      pool3.forEach(c => excludedIds.add(c.id));

      // Pool 4 (additive): guaranteed origin-layer slot. Best-matching historical_corpus chunks
      // above CORPUS_FLOOR that aren't already surfaced by pools 1-3. This is ON TOP of `limit`,
      // not carved out of it, so the relevance/novelty/edge pools are never demoted -- the corpus
      // only ever ADDS its voice when it's genuinely relevant to the query.
      // Skipped entirely when limit=0 (caller signalled they want no results).
      // SKIPPED in lexical mode: CORPUS_FLOOR is a COSINE threshold (0.35), so there is no way to tell whether
      // a corpus chunk is genuinely relevant to the query. The guarantee exists to give the origin layer a
      // voice when it deserves one, not to inject it unconditionally.
      const pool4 = limit > 0 && queryEmbedding ? store.searchByContentType(
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

      return {
        chunks: [...fmt(pool1, 1), ...fmt(pool2, 2), ...fmt(pool3, 3), ...fmt(pool4, 4)],
        // Present only when degraded, so the healthy payload is byte-identical to before.
        ...(degraded ? { degraded, degraded_note: "Embedder unavailable: keyword (BM25) results only. Semantic matches, the serendipity pool and the guaranteed corpus slot are all absent -- absence here does NOT mean absence from the vault." } : {}),
      };
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

    // sb_search_by_tags: the third search shape (2026-07-08). Exact tag lookup -- distinct from
    // sb_search's concept/similarity ranking and sb_file_chunks' path matching. Matches ANY of the
    // given tags. Currently populated for companion_journal rows only (domain + content-keyword
    // tags auto-classified at write time); other source tables don't tag yet.
    async sb_search_by_tags(args: { tags: string[]; limit?: number }) {
      const tags = (args.tags ?? []).filter(t => typeof t === "string" && t.trim().length > 0);
      if (tags.length === 0) return { chunks: [], note: "no tags given" };
      const limit = args.limit ?? 20;
      const results = store.searchByTags(tags, limit);
      // A tag lookup is a LISTING (often many results), not a single deep-dive match like
      // sb_search's top hit -- chunk_text/prefixed_text carry the full DeepSeek-wrapped
      // narrative plus the raw source JSON (often 1000+ chars each), which blew Halseth's
      // response budget down to 1 of 8 real matches surviving (2026-07-09 finding). Trimming
      // to an excerpt here means the caller sees every match; vault_path/id are still full,
      // so sb_file_chunks or a direct read can pull the complete entry when that's wanted.
      const EXCERPT_CHARS = 250;
      return {
        matched_tags: tags,
        chunks: results.map(chunk => {
          const full = chunk.chunk_text ?? chunk.prefixed_text ?? "";
          return {
            id: chunk.id,
            vault_path: chunk.vault_path,
            text: full.length > EXCERPT_CHARS ? full.slice(0, EXCERPT_CHARS) + "…" : full,
            tags: chunk.tags,
            content_type: chunk.content_type,
          };
        }),
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
