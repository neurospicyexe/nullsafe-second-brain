import type { VectorStore } from "../store/vector-store.js";
import type { Indexer } from "../indexer.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

export function buildSystemTools(store: VectorStore, indexer: Indexer, _adapter: VaultAdapter) {
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

    async sb_reindex_note(args: { path: string }) {
      await indexer.reindex(args.path);
      return { path: args.path, status: "reindexed" as const };
    },

    async sb_index_rebuild(args: { paths: string[] }) {
      for (const path of args.paths) {
        await indexer.reindex(path);
      }
      return { rebuilt: args.paths.length };
    },
  };
}
