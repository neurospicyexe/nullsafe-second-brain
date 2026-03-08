import type { VectorStore, ChunkRow } from "../store/vector-store.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

export function buildRetrievalTools(store: VectorStore, embedder: Embedder) {
  return {
    async sb_search(args: { query: string; limit?: number }) {
      const queryEmbedding = await embedder.embed(args.query);
      const limit = args.limit ?? 10;
      const all = store.getAll();
      const ranked = all
        .map(chunk => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { chunks: ranked };
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
