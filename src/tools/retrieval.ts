import type { VectorStore } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

export function buildRetrievalTools(store: VectorStore, embedder: Embedder) {
  return {
    async sb_search(args: { query: string; limit?: number }) {
      const limit = args.limit ?? 10;
      const pool1Size = Math.round(limit * 0.7);
      const pool2Size = Math.round(limit * 0.2);
      const pool3Size = limit - pool1Size - pool2Size;

      const queryEmbedding = await embedder.embed(args.query);

      // Pool 1 (70%): core relevance -- hybrid cosine + BM25
      const p1Candidates = store.hybridSearch(queryEmbedding, args.query, pool1Size * 5);
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

      // Fire-and-forget novelty decay for all returned chunks
      const allReturned = [
        ...pool1.map(c => ({ id: c.id, content_type: c.content_type })),
        ...pool2.map(c => ({ id: c.id, content_type: c.content_type })),
        ...pool3.map(c => ({ id: c.id, content_type: c.content_type })),
      ];
      if (allReturned.length > 0) {
        try { store.updateNoveltyScores(allReturned); } catch {}
      }

      const fmt = (chunks: typeof pool1, pool: 1 | 2 | 3) =>
        chunks.map(chunk => ({
          vault_path: chunk.vault_path,
          text: chunk.chunk_text ?? chunk.prefixed_text ?? "",
          section: chunk.section ?? "",
          score: chunk.score,
          novelty_score: chunk.novelty_score,
          pool,
        }));

      return { chunks: [...fmt(pool1, 1), ...fmt(pool2, 2), ...fmt(pool3, 3)] };
    },

    async sb_recall(args: { companion: string | null; content_type?: string; limit?: number }) {
      const chunks = store.filterByCompanion(args.companion);
      const filtered = args.content_type ? chunks.filter(c => c.content_type === args.content_type) : chunks;
      return { chunks: filtered.slice(0, args.limit ?? 20) };
    },

    async sb_recent_patterns(args: { vaultAdapter: VaultAdapter; summaryPath: string }) {
      if (!await args.vaultAdapter.exists(args.summaryPath)) return { summary: null };
      const summary = await args.vaultAdapter.read(args.summaryPath);
      return { summary };
    },
  };
}
