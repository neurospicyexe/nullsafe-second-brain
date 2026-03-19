import type { VectorStore } from "../store/vector-store.js";
import type { Indexer } from "../indexer.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";
import type { Embedder } from "../embeddings/embedder.js";

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

export function buildSystemTools(store: VectorStore, indexer: Indexer, adapter: VaultAdapter, embedder: Embedder) {
  return {
    async sb_status() {
      const chunks = store.getAll();
      const companions = [...new Set(chunks.map(c => c.companion).filter((c): c is string => c !== null))];
      return {
        total_chunks: chunks.length,
        companions_indexed: companions,
        content_types: [...new Set(chunks.map(c => c.content_type))],
      };
    },

    async sb_index_rebuild(args: { paths: string[] }) {
      for (const path of args.paths) {
        await indexer.reindex(path);
      }
      return { rebuilt: args.paths.length };
    },

    async sb_read(args: { path: string; query?: string }) {
      if (args.query) {
        const chunks = store.filterByPath(args.path);
        if (chunks.length > 0) {
          const queryEmbedding = await embedder.embed(args.query);
          const ranked = chunks
            .map(chunk => ({
              section: chunk.section ?? "",
              text: chunk.chunk_text,
              score: cosineSimilarity(queryEmbedding, chunk.embedding),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(({ section, text }) => ({ section, text }));
          return { path: args.path, mode: "excerpts" as const, excerpts: ranked };
        }
      }
      const content = await adapter.read(args.path);
      return { path: args.path, content };
    },

    async sb_list(args: { path?: string }) {
      const entries = await adapter.list(args.path ?? "");
      return { entries };
    },

    async sb_move(args: { from: string; to: string }) {
      await adapter.move(args.from, args.to);
      store.deleteByPath(args.from);
      await indexer.reindex(args.to);
      return { from: args.from, to: args.to };
    },
  };
}
