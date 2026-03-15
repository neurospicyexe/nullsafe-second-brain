import type { VectorStore } from "../store/vector-store.js";
import type { Indexer } from "../indexer.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

export function buildSystemTools(store: VectorStore, indexer: Indexer, adapter: VaultAdapter) {
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

    async sb_read(args: { path: string }) {
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
