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
      // `pending_index` = vault files that are DURABLE but NOT SEARCHABLE (written while the embedder was
      // down). Surfaced here because an unsearchable file is invisible by definition -- if the count is not
      // shown somewhere, nobody learns the memory has a hole until they reach for something and miss.
      const pendingIndex = store.pendingIndexCount();
      const pendingSample = pendingIndex > 0 ? store.listPendingIndex(3) : [];
      return {
        total_chunks: chunks.length,
        companions_indexed: companions,
        content_types: [...new Set(chunks.map(c => c.content_type))],
        ...(pendingIndex > 0 ? {
          pending_index: pendingIndex,
          pending_index_note: "Written to the vault but not indexed (embedder unavailable). Readable now, NOT searchable until drained; retries automatically.",
          pending_index_oldest: pendingSample[0]?.first_failed_at ?? null,
          pending_index_sample: pendingSample.map(p => p.vault_path),
        } : {}),
      };
    },

    /** Manual drain, for when credits land and you would rather not wait for the next cron tick. */
    async sb_index_drain(args: { limit?: number }) {
      return indexer.drainPendingIndex(args.limit ?? 100);
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
          // Excerpt mode is PURE cosine ranking, so a dead embedder leaves nothing to rank with. Degrade to
          // returning the whole file (below) rather than to three excerpts picked by a broken ranker: the
          // caller asked for the relevant parts of a file, and all of it is a truthful superset of that.
          // Reading a vault file must never depend on a paid remote service being funded.
          let queryEmbedding: number[] | null = null;
          try {
            queryEmbedding = await embedder.embed(args.query);
          } catch (err) {
            console.error(`[sb_read] embedder unavailable, returning full file instead of excerpts: ${(err as Error).message}`);
          }
          if (queryEmbedding) {
            const qe = queryEmbedding;
            const ranked = chunks
              .map(chunk => ({
                section: chunk.section ?? "",
                text: chunk.chunk_text,
                score: cosineSimilarity(qe, chunk.embedding),
              }))
              .sort((a, b) => b.score - a.score)
              .slice(0, 3)
              .map(({ section, text }) => ({ section, text }));
            return { path: args.path, mode: "excerpts" as const, excerpts: ranked };
          }
          // Embedder down -> fall through to the full-file read below, and SAY so, because the caller asked
          // for excerpts and is getting something different.
          const content = await adapter.read(args.path);
          return {
            path: args.path,
            content,
            degraded: "full_file_no_ranker" as const,
            degraded_note: "Embedder unavailable: returning the whole file instead of the 3 most relevant excerpts.",
          };
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
