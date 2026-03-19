import type { VectorStore } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

export function buildRetrievalTools(store: VectorStore, embedder: Embedder) {
  return {
    async sb_search(args: { query: string; limit?: number }) {
      const limit = args.limit ?? 10;
      const queryEmbedding = await embedder.embed(args.query);
      const candidates = store.hybridSearch(queryEmbedding, args.query, limit * 5);

      // Per-doc dedup: keep at most 2 results per vault_path (preserving score order)
      const countByPath = new Map<string, number>();
      const deduped = candidates.filter(chunk => {
        const count = countByPath.get(chunk.vault_path) ?? 0;
        if (count >= 2) return false;
        countByPath.set(chunk.vault_path, count + 1);
        return true;
      });

      const results = deduped.slice(0, limit).map(chunk => ({
        vault_path: chunk.vault_path,
        text: chunk.chunk_text ?? chunk.prefixed_text ?? "",
        section: chunk.section ?? "",
        score: chunk.score,
      }));

      return { chunks: results };
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
