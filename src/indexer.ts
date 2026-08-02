import type { VaultAdapter } from "./adapters/vault-adapter.js";
import type { Embedder } from "./embeddings/embedder.js";
import type { VectorStore } from "./store/vector-store.js";
import type { ContentType } from "./types.js";

interface WriteOptions {
  path: string;
  content: string;
  companion: string | null;
  content_type: ContentType;
  tags: string[];
  overwrite?: boolean;
}

export interface ChunkOutput {
  text: string;
  section: string;
  index: number;
}

export function paragraphChunk(text: string, maxChars = 1000, overlap = 200): ChunkOutput[] {
  if (text.trim().length === 0) return [];
  const results: ChunkOutput[] = [];
  const paragraphs = text.split(/\n\n+/);
  let window = "";
  let windowSection = "";
  let currentSection = "";
  let chunkIndex = 0;
  let overlapTail = "";

  const emit = () => {
    const trimmed = window.trim();
    if (!trimmed) return;
    results.push({ text: trimmed, section: windowSection, index: chunkIndex++ });
    overlapTail = overlap > 0 ? trimmed.slice(-overlap) : "";
    window = overlapTail;
    windowSection = currentSection;
  };

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Update section heading tracker
    const headingMatch = trimmed.match(/^#{1,2}\s+(.+)/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      // Headings are short -- include them in the window so section context appears in chunks
    }

    if (trimmed.length > maxChars) {
      // Paragraph too large -- must split on sentence boundaries
      // First emit current window if non-empty
      if (window.trim()) emit();

      const sentences = trimmed.split(/(?<=\. )/);
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;
        if (window) {
          if (window.length + s.length + 1 > maxChars) emit();
          window = window + " " + s;
        } else if (s.length > maxChars) {
          // Single sentence exceeds maxChars -- hard-slice at maxChars
          // Cap slice overlap to half of maxChars so the remaining string always shrinks
          const sliceOverlap = Math.min(overlap, Math.floor(maxChars / 2));
          let remaining = s;
          while (remaining.length > maxChars) {
            results.push({ text: remaining.slice(0, maxChars), section: windowSection || currentSection, index: chunkIndex++ });
            overlapTail = remaining.slice(maxChars - sliceOverlap, maxChars);
            remaining = overlapTail + remaining.slice(maxChars);
            windowSection = currentSection;
          }
          window = remaining;
          if (!windowSection) windowSection = currentSection;
        } else {
          window = s;
          if (!windowSection) windowSection = currentSection;
        }
      }
    } else {
      // Check if adding this paragraph would exceed maxChars
      const wouldBe = window ? window.length + 2 + trimmed.length : trimmed.length;
      if (window && wouldBe > maxChars) {
        emit();
      }
      // Accumulate into window
      window = window ? window + "\n\n" + trimmed : trimmed;
      if (!windowSection) windowSection = currentSection;
    }
  }

  // Emit any remaining window
  if (window.trim()) {
    results.push({ text: window.trim(), section: windowSection, index: chunkIndex++ });
  }

  return results;
}

export function contextPrefix(meta: { path: string; companion: string | null; contentType: string; section: string }): string {
  const parts = [meta.path];
  if (meta.companion) parts.push(`companion:${meta.companion}`);
  parts.push(meta.contentType);
  const sectionLine = meta.section ? `\n## ${meta.section}` : "";
  return `${parts.join(" | ")}:${sectionLine}\n`;
}

/** After this many failed attempts, a path whose FILE cannot be read is dropped from the queue rather than
 *  blocking it forever. Only applies to missing-file errors -- an embedder outage must never drop anything. */
const MAX_PENDING_ATTEMPTS = 5;

export class Indexer {
  constructor(
    private adapter: VaultAdapter,
    private embedder: Embedder,
    private store: VectorStore,
  ) {}

  /**
   * THE VAULT IS TRUTH; THE INDEX IS DERIVED.
   *
   * The vault write and the index insert used to be equally fatal, so when the embedder went down (OpenAI out
   * of credits, 2026-08-01) every write through here reported FAILURE to its caller -- even though the file had
   * already landed on the line above and was perfectly durable. Two bad consequences at once: callers saw
   * data loss where there was none (and may retry, duplicating), and nothing anywhere recorded that the file
   * still needed indexing, so it would never become searchable. `rebuildAll()` could not save it either -- it
   * enumerates paths already IN the index.
   *
   * So an index failure no longer fails the write. It is recorded in `pending_index` and drained later. This
   * is the same covenant the suite already states for Vectorize ("the index is rebuildable; D1 is truth") --
   * it just had not been applied to the write path.
   *
   * NOT silent: the path is queued, counted in `sb_status`, and logged. A write that succeeded-but-unsearchable
   * is a different fact from a write that succeeded, and the caller can see which it got.
   */
  async write(options: WriteOptions): Promise<{ indexed: boolean; pending_reason?: string }> {
    await this.adapter.write({
      path: options.path,
      content: options.content,
      overwrite: options.overwrite ?? true,
    });
    try {
      await this.indexContent(
        options.path,
        options.content,
        options.companion,
        options.content_type,
        options.tags,
      );
      // A successful index supersedes any earlier failure for this path.
      try { this.store.clearPendingIndex(options.path); } catch { /* non-fatal */ }
      return { indexed: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[indexer] wrote ${options.path} but indexing FAILED (queued for retry): ${reason}`);
      try {
        this.store.markPendingIndex(
          options.path, options.companion ?? null, options.content_type ?? "note", options.tags ?? [], reason,
        );
      } catch (qErr) {
        // If even the queue write fails, this IS data loss of the searchability signal -- say so loudly.
        console.error(`[indexer] CRITICAL: could not queue ${options.path} for reindex: ${String(qErr)}`);
      }
      return { indexed: false, pending_reason: reason };
    }
  }

  /**
   * Retry everything that landed in the vault but never made it into the index.
   *
   * Called by the scheduler, so recovery from an embedder outage needs no human to remember anything --
   * "anything you have to remember is a defect". Ordered oldest-first: the longest-unsearchable file is the
   * one most likely to be reached for and missed.
   */
  async drainPendingIndex(limit = 100): Promise<{ attempted: number; recovered: number; still_pending: number }> {
    const pending = this.store.listPendingIndex(limit);
    if (pending.length === 0) return { attempted: 0, recovered: 0, still_pending: 0 };

    let recovered = 0;
    for (const p of pending) {
      try {
        const content = await this.adapter.read(p.vault_path);
        await this.indexContent(p.vault_path, content, p.companion, p.content_type as ContentType, p.tags);
        this.store.clearPendingIndex(p.vault_path);
        recovered++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Still failing. Leave it queued; bump the attempt count.
        this.store.markPendingIndex(p.vault_path, p.companion, p.content_type, p.tags, reason);

        // POISON PILL GUARD (2026-08-02). This used to `break` unconditionally on the first failure, which
        // is right for "the embedder is still down" -- do not hammer a dead paid API once per queued file --
        // and catastrophic for a path whose vault file was since deleted or renamed. That entry throws
        // forever, sits at the head of an oldest-first list, and permanently blocks every other queued file
        // from draining, INCLUDING after the embedder recovers. `pending_index` would then never clear and
        // sb_status would report a hole that can never close.
        //
        // So: distinguish the two. A file we cannot READ is this entry's problem -- skip past it and keep
        // draining. Anything else (embedder, network) is everyone's problem -- stop for this tick.
        const missingFile = /ENOENT|not found|no such file|404/i.test(reason);
        if (missingFile && p.attempts + 1 >= MAX_PENDING_ATTEMPTS) {
          console.error(`[indexer] dropping ${p.vault_path} from pending_index after ${p.attempts + 1} attempts: ${reason}`);
          this.store.clearPendingIndex(p.vault_path);
          continue;
        }
        if (missingFile) continue;
        break;
      }
    }
    const stillPending = this.store.pendingIndexCount();
    if (recovered > 0 || stillPending > 0) {
      console.log(`[indexer] drainPendingIndex: recovered=${recovered} still_pending=${stillPending}`);
    }
    return { attempted: pending.length, recovered, still_pending: stillPending };
  }

  async reindex(vaultPath: string): Promise<void> {
    // Use the indexed filterByPath query rather than getAll().find() to avoid
    // loading and deserializing every row in the store just to get metadata for one path.
    const existing = this.store.filterByPath(vaultPath)[0];
    const companion = existing?.companion ?? null;
    const content_type = (existing?.content_type ?? "note") as ContentType;
    const tags = existing?.tags ?? [];

    const content = await this.adapter.read(vaultPath);
    // deleteByPath is called again inside indexContent — no need to call it here too.
    await this.indexContent(vaultPath, content, companion, content_type, tags);
  }

  /**
   * Full rebuild of the vector index from the source of truth (the vault).
   * The store is regenerable: when the embedding model changes, every vector must
   * be re-embedded in the new space. Re-embeds the currently-indexed corpus,
   * preserving companion/content_type/tags per path (same metadata philosophy as
   * reindex). Content is re-read from the vault; metadata is carried from the index.
   *
   * Idempotent: clears the store, then re-indexes each path. Safe to re-run.
   * Note: this re-embeds the paths already in the index -- it does not enumerate
   * the vault, so a fully-empty index must be repopulated via the normal write flow.
   */
  async rebuildAll(): Promise<{ paths: number; chunks: number }> {
    // Snapshot path metadata to a recovery table before wiping. If the process is killed
    // mid-rebuild, this table persists and initialize() emits a warning on next startup,
    // prompting the operator to re-run `npm run rebuild`.
    this.store.saveRebuildCheckpoint();

    // Collect path metadata WITHOUT loading embedding blobs (GROUP BY avoids per-chunk rows).
    const rows = this.store.distinctPaths();
    const metaByPath = new Map(rows.map(r => [
      r.vault_path,
      {
        companion: r.companion ?? null,
        content_type: (r.content_type ?? "note") as ContentType,
        tags: (() => { try { return JSON.parse(r.tags) as string[]; } catch { return []; } })(),
      },
    ]));

    this.store.clear();

    for (const [vaultPath, meta] of metaByPath) {
      try {
        const content = await this.adapter.read(vaultPath);
        await this.indexContent(vaultPath, content, meta.companion, meta.content_type, meta.tags);
      } catch (err) {
        console.error(`[rebuildAll] failed for ${vaultPath}:`, err);
      }
    }

    this.store.clearRebuildCheckpoint();
    return { paths: metaByPath.size, chunks: this.store.count() };
  }

  private async indexContent(
    vaultPath: string,
    content: string,
    companion: string | null,
    content_type: ContentType,
    tags: string[],
  ): Promise<void> {
    const chunks = paragraphChunk(content);
    if (chunks.length === 0) return;
    const prefixedTexts = chunks.map(c =>
      contextPrefix({ path: vaultPath, companion, contentType: content_type, section: c.section }) + c.text
    );
    const embeddings = await this.embedder.embedBatch(prefixedTexts);
    this.store.deleteByPath(vaultPath);
    for (let i = 0; i < chunks.length; i++) {
      this.store.insert({
        vault_path: vaultPath,
        companion,
        content_type,
        chunk_text: chunks[i].text,
        prefixed_text: prefixedTexts[i],
        section: chunks[i].section,
        chunk_index: chunks[i].index,
        embedding: embeddings[i],
        tags,
      });
    }
  }
}
