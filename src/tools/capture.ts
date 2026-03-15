import type { Indexer } from "../indexer.js";
import type { RouteResolver } from "../router.js";
import type { ContentType } from "../types.js";
import { randomUUID } from "crypto";

function timestamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureMd(path: string): string {
  return path.endsWith(".md") ? path : path + ".md";
}

export function buildCaptureTools(indexer: Indexer, resolver: RouteResolver) {
  return {
    async sb_save_document(args: { path?: string; content: string; companion?: string; tags?: string[]; content_type?: "document" | "note" }) {
      const companion = args.companion?.toLowerCase() ?? null;
      const tags = args.tags ?? [];
      const type = args.content_type ?? "document";
      const finalPath = ensureMd(args.path ?? `${resolver.resolve({ companion, type, tags })}${timestamp()}-${type}.md`);
      await indexer.write({ path: finalPath, content: args.content, companion, content_type: type, tags });
      return { path: finalPath };
    },

    async sb_save_study(args: { content: string; subject?: string; tags?: string[] }) {
      const tags = args.tags ?? [];
      const base = resolver.resolve({ companion: null, type: "study", tags });
      const subjectPath = args.subject ? `${base}${args.subject}/` : base;
      const finalPath = `${subjectPath}${timestamp()}-study.md`;
      await indexer.write({ path: finalPath, content: args.content, companion: null, content_type: "study", tags });
      return { path: finalPath };
    },

    async sb_log_observation(args: { content: string; tags?: string[] }) {
      const tags = args.tags ?? [];
      const destination = resolver.resolve({ companion: null, type: "observation", tags });
      const finalPath = `${destination}observation-${timestamp()}-${randomUUID().slice(0, 8)}.md`;
      await indexer.write({ path: finalPath, content: args.content, companion: null, content_type: "observation", tags });
      return { path: finalPath };
    },
  };
}
