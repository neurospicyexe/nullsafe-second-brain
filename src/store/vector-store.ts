import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "crypto";
import { emotionResonance } from "./emotion-space.js";
import { recencyBoost, recencyWeight, recencyHalfLifeDays } from "./recency.js";

/**
 * THE CHATTER LANE: searchable, barred from the recency lanes (2026-08-10).
 *
 * Pools 2 (novelty) and 3 (serendipity) both rank by `novelty_score DESC` over the whole store, and a
 * freshly-inserted row starts at maximum novelty. So live Discord messages -- which arrive continuously --
 * would take over both query-blind pools permanently, and the commons seed and every autonomous surface
 * would be handed this afternoon's chat as its "unfamiliar material to think about".
 *
 * THAT is the real reason the write-side length gates existed (MIN_HUMAN_CHARS = 50 in the bots' sb-live
 * ingest): keeping chatter out of the STORE was the only lever available for keeping it out of these pools.
 * The cost was that the gate also ate the short messages that matter most for continuity -- "hey meet me in
 * the Fargo watch party channel" is 43 characters, so Raziel's exact reported scenario was discarded before
 * it was ever written.
 *
 * The correct discriminator is WHICH POOL a row may surface in, not WHETHER it is stored. Chatter stays
 * fully retrievable by relevance (pool 1, and recall mode) and is excluded here. That lets the length gates
 * come down without regrowing the noise pool that made recall unusable.
 */
const NOT_CHATTER_SQL = "COALESCE(section, '') != 'discord-live'";

export interface ChunkInsert {
  vault_path: string;
  companion: string | null;
  content_type: string;
  chunk_text: string;
  prefixed_text?: string;
  section?: string;
  chunk_index?: number;
  embedding: number[];
  tags: string[];
  /** Emotional valence at encoding time (e.g. the feeling's emotion label). Drives resonance boost. */
  valence?: string | null;
}

export interface ChunkRow {
  id: string;
  vault_path: string;
  companion: string | null;
  content_type: string;
  chunk_text: string;
  prefixed_text: string | null;
  section: string | null;
  chunk_index: number | null;
  embedding: number[];
  tags: string[];
  created_at: string;
  novelty_score: number;
  last_surfaced_at: string | null;
  valence: string | null;
  /** Metamemory (0070): how often this chunk was rated useful/useless after recall. */
  useful_count: number;
  useless_count: number;
}

export class VectorStore {
  private db: Database.Database;
  // ANN (sqlite-vec) state. If the extension fails to load, vecEnabled stays false and
  // search degrades gracefully to BM25 + novelty fallback — never breaks.
  private vecEnabled = false;
  private vecDim: number | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      sqliteVec.load(this.db);
      this.vecEnabled = true;
    } catch (e) {
      console.error("[vector-store] sqlite-vec load failed — ANN disabled, falling back to BM25:", e);
      this.vecEnabled = false;
    }
  }

  initialize(): void {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        vault_path TEXT NOT NULL,
        companion TEXT,
        content_type TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_companion ON embeddings(companion)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_vault_path ON embeddings(vault_path)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_content_type ON embeddings(content_type)").run();

    // Additive migration: add columns only if absent. Note: chunk_text already exists -- do NOT add it.
    const cols = (this.db.prepare("PRAGMA table_info(embeddings)").all() as { name: string }[]).map(c => c.name);
    if (!cols.includes("prefixed_text"))   this.db.prepare("ALTER TABLE embeddings ADD COLUMN prefixed_text TEXT").run();
    if (!cols.includes("section"))         this.db.prepare("ALTER TABLE embeddings ADD COLUMN section TEXT").run();
    if (!cols.includes("chunk_index"))     this.db.prepare("ALTER TABLE embeddings ADD COLUMN chunk_index INTEGER").run();
    if (!cols.includes("novelty_score"))   this.db.prepare("ALTER TABLE embeddings ADD COLUMN novelty_score REAL NOT NULL DEFAULT 1.0").run();
    if (!cols.includes("last_surfaced_at")) this.db.prepare("ALTER TABLE embeddings ADD COLUMN last_surfaced_at TEXT").run();
    if (!cols.includes("valence"))         this.db.prepare("ALTER TABLE embeddings ADD COLUMN valence TEXT").run();
    if (!cols.includes("useful_count"))    this.db.prepare("ALTER TABLE embeddings ADD COLUMN useful_count INTEGER NOT NULL DEFAULT 0").run();
    if (!cols.includes("useless_count"))   this.db.prepare("ALTER TABLE embeddings ADD COLUMN useless_count INTEGER NOT NULL DEFAULT 0").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_novelty ON embeddings(novelty_score DESC)").run();

    // FTS5 virtual table (content-based, backed by embeddings table)
    this.db.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_fts USING fts5(
        prefixed_text,
        content='embeddings',
        content_rowid='rowid'
      )
    `).run();

    // Triggers to keep FTS5 in sync
    this.db.prepare(`
      CREATE TRIGGER IF NOT EXISTS embeddings_ai AFTER INSERT ON embeddings WHEN new.prefixed_text IS NOT NULL BEGIN
        INSERT INTO embeddings_fts(rowid, prefixed_text) VALUES (new.rowid, new.prefixed_text);
      END
    `).run();
    this.db.prepare(`
      CREATE TRIGGER IF NOT EXISTS embeddings_ad AFTER DELETE ON embeddings WHEN old.prefixed_text IS NOT NULL BEGIN
        INSERT INTO embeddings_fts(embeddings_fts, rowid, prefixed_text) VALUES ('delete', old.rowid, old.prefixed_text);
      END
    `).run();
    this.db.prepare(`
      CREATE TRIGGER IF NOT EXISTS embeddings_au AFTER UPDATE ON embeddings BEGIN
        INSERT INTO embeddings_fts(embeddings_fts, rowid, prefixed_text)
          SELECT 'delete', old.rowid, old.prefixed_text WHERE old.prefixed_text IS NOT NULL;
        INSERT INTO embeddings_fts(rowid, prefixed_text)
          SELECT new.rowid, new.prefixed_text WHERE new.prefixed_text IS NOT NULL;
      END
    `).run();

    // Backfill FTS5 for any rows that have prefixed_text but aren't in FTS5 yet.
    // Use < (not === 0) so a partial sync after a crash is also repaired.
    const ftsCount = (this.db.prepare("SELECT count(*) as n FROM embeddings_fts").get() as { n: number }).n;
    const embeddingsWithPrefix = (this.db.prepare("SELECT count(*) as n FROM embeddings WHERE prefixed_text IS NOT NULL").get() as { n: number }).n;
    if (ftsCount < embeddingsWithPrefix) {
      this.db.prepare("INSERT INTO embeddings_fts(rowid, prefixed_text) SELECT rowid, prefixed_text FROM embeddings WHERE prefixed_text IS NOT NULL").run();
    }

    // Self-heal: rows inserted without prefixed_text (historically the ingestion-pipeline path)
    // never entered FTS5 and were invisible to keyword search. Backfill prefixed_text from
    // chunk_text so they become searchable. The AFTER UPDATE trigger syncs FTS5 automatically.
    // Idempotent: the WHERE guard makes this a no-op once every row has prefixed_text.
    this.db.prepare(
      "UPDATE embeddings SET prefixed_text = chunk_text WHERE prefixed_text IS NULL AND chunk_text IS NOT NULL AND chunk_text != ''"
    ).run();

    // ANN index (sqlite-vec): build a vec0 KNN table over the embeddings we ALREADY have, so
    // purely conceptual queries (sharing no keywords with the text) still surface relevant chunks.
    // No re-embedding — the vectors are reused from the embeddings.embedding column. Idempotent:
    // detect dimension from existing rows, create the table, backfill only rows not yet indexed.
    if (this.vecEnabled) {
      try {
        const sample = this.db.prepare(
          "SELECT embedding FROM embeddings WHERE embedding IS NOT NULL LIMIT 1"
        ).get() as { embedding: string } | undefined;
        if (sample) {
          const dim = (JSON.parse(sample.embedding) as number[]).length;
          if (this.ensureVecTable(dim)) {
            const info = this.db.prepare(
              "INSERT INTO vec_embeddings(rowid, embedding) SELECT rowid, embedding FROM embeddings WHERE embedding IS NOT NULL AND rowid NOT IN (SELECT rowid FROM vec_embeddings)"
            ).run();
            if (info.changes > 0) console.log(`[vector-store] ANN backfill indexed ${info.changes} embeddings (dim ${dim})`);
          }
        }
      } catch (e) {
        console.error("[vector-store] ANN backfill failed — ANN disabled:", e);
        this.vecEnabled = false;
      }
    }

    // Warn if a previous rebuild was interrupted -- the checkpoint table persists across restarts
    // so the operator knows to re-run `npm run rebuild` to complete the job.
    if (this.hasRebuildCheckpoint()) {
      console.warn(
        "[vector-store] WARNING: Found an incomplete rebuild checkpoint (embeddings_rebuild_checkpoint table). " +
        "A previous 'npm run rebuild' was interrupted mid-run. Re-run it to restore a complete index."
      );
    }
  }

  // ── Rebuild checkpoint ──────────────────────────────────────────────────────
  // rebuildAll() snapshots path metadata here before wiping the store. If the process
  // is killed mid-rebuild the checkpoint survives, initialize() emits a recovery warning,
  // and the operator knows to re-run `npm run rebuild`.

  // ── Pending-index queue ────────────────────────────────────────────────────────────────────────────
  //
  // THE HOLE THIS PLUGS (2026-08-01). `Indexer.write()` writes the vault file FIRST and embeds SECOND. When
  // the embedder is down the file lands and is durable, but the index insert throws -- and NOTHING recorded
  // that the file still needed indexing. `rebuildAll()` cannot recover it either: it enumerates
  // `distinctPaths()`, i.e. paths ALREADY in the index, so a file that was never indexed is invisible to the
  // one tool built to fix the index. A week-long embedder outage would therefore have left a permanent,
  // silent hole in the long-term memory: the writing kept succeeding, the searching just quietly never
  // included it.
  //
  // Deliberately its own tiny table rather than a flag on `embeddings`: there is no embeddings row to flag.
  // That absence IS the bug.

  markPendingIndex(vaultPath: string, companion: string | null, contentType: string, tags: string[], reason: string): void {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS pending_index (
        vault_path TEXT PRIMARY KEY,
        companion TEXT,
        content_type TEXT,
        tags TEXT,
        reason TEXT,
        first_failed_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_attempt_at TEXT NOT NULL
      )
    `).run();
    const now = new Date().toISOString();
    // ON CONFLICT keeps first_failed_at (how long has this been unsearchable?) and counts attempts, so a
    // path stuck for days is distinguishable from one that failed once.
    this.db.prepare(`
      INSERT INTO pending_index (vault_path, companion, content_type, tags, reason, first_failed_at, attempts, last_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(vault_path) DO UPDATE SET
        attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, reason = excluded.reason
    `).run(vaultPath, companion, contentType, JSON.stringify(tags ?? []), reason.slice(0, 300), now, now);
  }

  listPendingIndex(limit = 500): Array<{ vault_path: string; companion: string | null; content_type: string; tags: string[]; reason: string; first_failed_at: string; attempts: number }> {
    if (!this.tableExists("pending_index")) return [];
    const rows = this.db.prepare(
      "SELECT vault_path, companion, content_type, tags, reason, first_failed_at, attempts FROM pending_index ORDER BY first_failed_at ASC LIMIT ?"
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      vault_path: r.vault_path as string,
      companion: (r.companion as string | null) ?? null,
      content_type: (r.content_type as string) ?? "note",
      tags: (() => { try { return JSON.parse((r.tags as string) ?? "[]") as string[]; } catch { return []; } })(),
      reason: (r.reason as string) ?? "",
      first_failed_at: r.first_failed_at as string,
      attempts: Number(r.attempts ?? 0),
    }));
  }

  clearPendingIndex(vaultPath: string): void {
    if (!this.tableExists("pending_index")) return;
    this.db.prepare("DELETE FROM pending_index WHERE vault_path = ?").run(vaultPath);
  }

  /** Count of vault files that are durable but NOT searchable. Surfaced in sb_status so it is visible. */
  pendingIndexCount(): number {
    if (!this.tableExists("pending_index")) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pending_index").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  private tableExists(name: string): boolean {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
  }

  // ── pending_embed: the queue for writes with NO durable source to re-read (2026-08-10) ────────
  //
  // `pending_index` above recovers a failed index by re-reading the VAULT FILE, which makes it useless for
  // the HTTP ingest routes that deliberately write no file. `/ingest/discord` is vector-store-only, so when
  // the embedder failed the message was not queued anywhere -- it 500'd and was GONE.
  //
  // Measured cost of that gap: the OpenAI credit balance hit zero on 2026-07-31 and every Discord message
  // from then to 2026-08-10 was dropped on the floor, nine days in which the bots' per-message recall had
  // nothing current to find. The 2026-08-01 "a write can never be lost" hardening covered the vault path and
  // missed every HTTP entrypoint, which is the entrypoint that carries live conversation.
  //
  // So this table stores the TEXT, not a pointer to it. That is the whole difference: there is no source of
  // truth to go back to, so the queue has to BE one.
  markPendingEmbed(rec: {
    vaultPath: string; companion: string | null; contentType: string; section: string;
    text: string; prefixedText: string; tags: string[]; reason: string;
  }): void {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS pending_embed (
        vault_path TEXT PRIMARY KEY,
        companion TEXT,
        content_type TEXT,
        section TEXT,
        chunk_text TEXT NOT NULL,
        prefixed_text TEXT NOT NULL,
        tags TEXT,
        reason TEXT,
        first_failed_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_attempt_at TEXT NOT NULL
      )
    `).run();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO pending_embed (vault_path, companion, content_type, section, chunk_text, prefixed_text, tags, reason, first_failed_at, attempts, last_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(vault_path) DO UPDATE SET
        attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, reason = excluded.reason
    `).run(
      rec.vaultPath, rec.companion, rec.contentType, rec.section,
      rec.text, rec.prefixedText, JSON.stringify(rec.tags ?? []), rec.reason.slice(0, 300), now, now,
    );
  }

  listPendingEmbed(limit = 200): Array<{
    vault_path: string; companion: string | null; content_type: string; section: string;
    chunk_text: string; prefixed_text: string; tags: string[]; first_failed_at: string; attempts: number;
  }> {
    if (!this.tableExists("pending_embed")) return [];
    const rows = this.db.prepare(
      "SELECT * FROM pending_embed ORDER BY first_failed_at ASC LIMIT ?"
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      vault_path: r.vault_path as string,
      companion: (r.companion as string | null) ?? null,
      content_type: (r.content_type as string) ?? "observation",
      section: (r.section as string) ?? "",
      chunk_text: (r.chunk_text as string) ?? "",
      prefixed_text: (r.prefixed_text as string) ?? "",
      tags: (() => { try { return JSON.parse((r.tags as string) ?? "[]") as string[]; } catch { return []; } })(),
      first_failed_at: r.first_failed_at as string,
      attempts: Number(r.attempts ?? 0),
    }));
  }

  clearPendingEmbed(vaultPath: string): void {
    if (!this.tableExists("pending_embed")) return;
    this.db.prepare("DELETE FROM pending_embed WHERE vault_path = ?").run(vaultPath);
  }

  /** Live conversation that is durable in the queue but not yet searchable. Surfaced in /health. */
  pendingEmbedCount(): number {
    if (!this.tableExists("pending_embed")) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pending_embed").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Oldest queue entry's age in hours -- the honest "how stale is recall" number. 0 when empty. */
  pendingEmbedOldestAgeHours(): number {
    if (!this.tableExists("pending_embed")) return 0;
    const row = this.db.prepare("SELECT MIN(first_failed_at) AS t FROM pending_embed").get() as { t: string | null } | undefined;
    if (!row?.t) return 0;
    const ms = Date.now() - Date.parse(row.t);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 36_000) / 100 : 0;
  }

  saveRebuildCheckpoint(): void {
    this.db.prepare("DROP TABLE IF EXISTS embeddings_rebuild_checkpoint").run();
    this.db.prepare(`
      CREATE TABLE embeddings_rebuild_checkpoint AS
      SELECT vault_path, companion, content_type, tags FROM embeddings GROUP BY vault_path
    `).run();
  }

  clearRebuildCheckpoint(): void {
    this.db.prepare("DROP TABLE IF EXISTS embeddings_rebuild_checkpoint").run();
  }

  hasRebuildCheckpoint(): boolean {
    const row = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings_rebuild_checkpoint'"
    ).get();
    return row !== undefined;
  }

  // Create the vec0 KNN virtual table lazily once the embedding dimension is known (it is fixed
  // at creation). Returns true if the table is ready for this dimension. Cosine distance matches
  // the existing hybridSearch scoring.
  private ensureVecTable(dim: number): boolean {
    if (!this.vecEnabled) return false;
    if (this.vecDim === dim) return true;
    if (this.vecDim !== null && this.vecDim !== dim) {
      console.error(`[vector-store] embedding dim mismatch (table=${this.vecDim}, got=${dim}); skipping ANN for this row`);
      return false;
    }
    if (!Number.isInteger(dim) || dim <= 0 || dim > 16000) return false;
    this.db.prepare(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding float[${dim}] distance_metric=cosine)`
    ).run();
    this.vecDim = dim;
    return true;
  }

  // KNN over the vec0 index. Returns rowids (matching embeddings.rowid) ordered by cosine distance.
  // vec0 REQUIRES a LIMIT or k= constraint. Returns [] when ANN is unavailable or dim mismatches.
  vectorSearch(queryEmbedding: number[], k: number): Array<{ rowid: number; distance: number }> {
    if (!this.vecEnabled || this.vecDim === null) return [];
    if (queryEmbedding.length !== this.vecDim) return [];
    if (k <= 0) return [];
    try {
      return this.db.prepare(
        "SELECT rowid, distance FROM vec_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
      ).all(JSON.stringify(queryEmbedding), k) as Array<{ rowid: number; distance: number }>;
    } catch (e) {
      console.error("[vector-store] vectorSearch failed:", e);
      return [];
    }
  }

  insert(chunk: ChunkInsert): string {
    const id = randomUUID();
    const info = this.db.prepare(`
      INSERT INTO embeddings
        (id, vault_path, companion, content_type, chunk_text, prefixed_text, section, chunk_index, embedding, tags, valence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, chunk.vault_path, chunk.companion, chunk.content_type, chunk.chunk_text,
      chunk.prefixed_text ?? null, chunk.section ?? null, chunk.chunk_index ?? null,
      JSON.stringify(chunk.embedding), JSON.stringify(chunk.tags), chunk.valence ?? null
    );

    // Keep the ANN index in sync. rowid must be bound as BigInt for vec0 (better-sqlite3 binds
    // plain JS numbers as REAL, which vec0 rejects for its integer primary key). Non-fatal.
    if (this.vecEnabled && Array.isArray(chunk.embedding) && chunk.embedding.length > 0
        && this.ensureVecTable(chunk.embedding.length)) {
      try {
        this.db.prepare("INSERT INTO vec_embeddings(rowid, embedding) VALUES (?, ?)")
          .run(BigInt(info.lastInsertRowid), JSON.stringify(chunk.embedding));
      } catch (e) {
        console.error("[vector-store] ANN insert sync failed (non-fatal) — run store.initialize() to backfill missing ANN rows:", e);
      }
    }
    return id;
  }

  getById(id: string): ChunkRow | undefined {
    const row = this.db.prepare("SELECT * FROM embeddings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.deserialize(row);
  }

  filterByCompanion(companion: string | null): ChunkRow[] {
    const rows = companion === null
      ? this.db.prepare("SELECT * FROM embeddings WHERE companion IS NULL").all() as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM embeddings WHERE companion = ?").all(companion) as Record<string, unknown>[];
    return rows.map(r => this.deserialize(r));
  }

  filterByPath(vaultPath: string): ChunkRow[] {
    return (this.db.prepare("SELECT * FROM embeddings WHERE vault_path = ? ORDER BY chunk_index ASC NULLS LAST").all(vaultPath) as Record<string, unknown>[])
      .map(r => this.deserialize(r));
  }

  filterByPathPrefix(prefix: string, limit: number = 100): ChunkRow[] {
    return (this.db.prepare(
      "SELECT * FROM embeddings WHERE vault_path LIKE ? ORDER BY vault_path ASC, chunk_index ASC NULLS LAST LIMIT ?"
    ).all(`${prefix}%`, limit) as Record<string, unknown>[])
      .map(r => this.deserialize(r));
  }

  filterByPathContains(term: string, limit: number = 100): ChunkRow[] {
    return (this.db.prepare(
      "SELECT * FROM embeddings WHERE vault_path LIKE ? ORDER BY vault_path ASC, chunk_index ASC NULLS LAST LIMIT ?"
    ).all(`%${term}%`, limit) as Record<string, unknown>[])
      .map(r => this.deserialize(r));
  }

  getAll(): ChunkRow[] {
    return (this.db.prepare("SELECT * FROM embeddings").all() as Record<string, unknown>[])
      .map(r => this.deserialize(r));
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM embeddings").get() as { n: number }).n;
  }

  getStoredDim(): number | null {
    return this.vecDim;
  }

  // Returns one metadata row per distinct vault_path without loading embedding blobs.
  // Used by rebuildAll() to collect the path list before clearing the store.
  distinctPaths(): Array<{ vault_path: string; companion: string | null; content_type: string; tags: string }> {
    return this.db.prepare(
      "SELECT vault_path, companion, content_type, tags FROM embeddings GROUP BY vault_path"
    ).all() as Array<{ vault_path: string; companion: string | null; content_type: string; tags: string }>;
  }

  deleteByPath(vaultPath: string): void {
    // Remove matching rows from the ANN index first (collect rowids before they're gone).
    if (this.vecEnabled && this.vecDim !== null) {
      const rows = this.db.prepare("SELECT rowid FROM embeddings WHERE vault_path = ?").all(vaultPath) as { rowid: number }[];
      for (const r of rows) {
        try { this.db.prepare("DELETE FROM vec_embeddings WHERE rowid = ?").run(BigInt(r.rowid)); } catch { /* non-fatal */ }
      }
    }
    this.db.prepare("DELETE FROM embeddings WHERE vault_path = ?").run(vaultPath);
  }

  /**
   * TTL prune for ephemeral path families (e.g. "discord-live/"). These rows are a
   * recency layer -- the durable record arrives via session synthesis -- so they age
   * out instead of accumulating. Returns rows removed. ANN rows removed first, same
   * pattern as deleteByPath.
   */
  pruneByPathPrefix(prefix: string, olderThanDays: number): number {
    const cutoffExpr = `-${Math.max(1, Math.floor(olderThanDays))} days`;
    if (this.vecEnabled && this.vecDim !== null) {
      const rows = this.db.prepare(
        "SELECT rowid FROM embeddings WHERE vault_path LIKE ? || '%' AND created_at < datetime('now', ?)"
      ).all(prefix, cutoffExpr) as { rowid: number }[];
      for (const r of rows) {
        try { this.db.prepare("DELETE FROM vec_embeddings WHERE rowid = ?").run(BigInt(r.rowid)); } catch { /* non-fatal */ }
      }
    }
    const info = this.db.prepare(
      "DELETE FROM embeddings WHERE vault_path LIKE ? || '%' AND created_at < datetime('now', ?)"
    ).run(prefix, cutoffExpr);
    return info.changes;
  }

  // Remove duplicate embedding rows that share the same (vault_path, chunk_index) -- genuine
  // re-embeds of one source record (e.g. the ingestion pipeline re-wrapping + re-inserting an
  // edited Halseth row without first deleting the prior embedding). Multi-chunk files are NOT
  // affected: their chunks have distinct chunk_index, so each (vault_path, chunk_index) is unique.
  // Keeps the newest row per group (MAX(rowid)) and deletes the rest, syncing the ANN table; the
  // AFTER DELETE trigger keeps FTS5 in sync. Returns the number of rows removed.
  // `dryRun` returns the count without deleting -- always check it before applying in prod.
  dedupeByPathAndIndex(dryRun = false): number {
    const victims = this.db.prepare(`
      SELECT rowid FROM embeddings
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM embeddings GROUP BY vault_path, IFNULL(chunk_index, -1)
      )
    `).all() as { rowid: number }[];
    if (dryRun || victims.length === 0) return victims.length;

    this.db.transaction(() => {
      for (const v of victims) {
        if (this.vecEnabled && this.vecDim !== null) {
          try { this.db.prepare("DELETE FROM vec_embeddings WHERE rowid = ?").run(BigInt(v.rowid)); } catch { /* non-fatal */ }
        }
        this.db.prepare("DELETE FROM embeddings WHERE rowid = ?").run(v.rowid);
      }
    })();
    return victims.length;
  }

  existsByPath(path: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM embeddings WHERE vault_path = ? LIMIT 1').get(path)
    return row !== undefined
  }

  /** Max cosine similarity between `embedding` and the newest `limit` rows whose
   *  vault_path starts with `prefix` and which are younger than `sinceDays`.
   *  Surprisal gate support (2026-06-12): discord-live rows are TTL-bounded, so a
   *  brute-force scan over the newest few hundred is cheap and avoids coupling the
   *  gate to sqlite-vec availability. Returns 0 when nothing matches. */
  maxSimilarityForPrefix(embedding: number[], prefix: string, sinceDays = 2, limit = 200): number {
    if (embedding.length === 0) return 0;
    const rows = this.db.prepare(`
      SELECT embedding FROM embeddings
      WHERE vault_path LIKE ? || '%' AND created_at > datetime('now', ?)
      ORDER BY created_at DESC LIMIT ?
    `).all(prefix, `-${sinceDays} days`, limit) as Array<{ embedding: string }>;
    let max = 0;
    const qNorm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0)) || 1;
    for (const row of rows) {
      let e: number[];
      try { e = JSON.parse(row.embedding) as number[]; } catch { continue; }
      if (!Array.isArray(e) || e.length !== embedding.length) continue;
      let dot = 0, n = 0;
      for (let i = 0; i < e.length; i++) { dot += e[i]! * embedding[i]!; n += e[i]! * e[i]!; }
      const sim = dot / ((Math.sqrt(n) || 1) * qNorm);
      if (sim > max) max = sim;
    }
    return max;
  }

  /**
   * Wipe the entire index. The vault is the source of truth; this store is
   * disposable and rebuildable (used by Indexer.rebuildAll(), e.g. after an
   * embedding-model swap when every vector must be regenerated in the new space).
   * Deleting from embeddings clears embeddings_fts via the AFTER DELETE trigger.
   * The vec0 ANN table has no triggers and is dimension-fixed, so drop it and
   * reset the cached dim -- the next insert recreates it at the current dimension.
   */
  clear(): void {
    this.db.prepare("DELETE FROM embeddings").run();
    try { this.db.prepare("DROP TABLE IF EXISTS vec_embeddings").run(); } catch { /* non-fatal */ }
    this.vecDim = null;
  }

  /**
   * `queryEmbedding` may be NULL: lexical-only mode (2026-08-01).
   *
   * The embedder is a PAID, remote single point of failure sitting in front of a lexical index that does not
   * need it. When OpenAI ran out of credits, `sb_search` threw on its first line and every companion lost
   * access to the entire vault -- while FTS5/BM25, which is local and free and already built over the same
   * corpus, would have answered fine. "All the history is in there" makes availability the property that
   * matters most, so a dead embedder must cost the semantic half of search and nothing else.
   *
   * In lexical mode: no ANN candidates, no cosine term (normV contributes 0), BM25 carries the ranking, and
   * the recency / resonance / metamemory nudges still apply because none of them need a query vector.
   */
  hybridSearch(queryEmbedding: number[] | null, queryText: string, limit: number, mood?: string): Array<ChunkRow & { score: number; cosine: number | null }> {
    // Step 1: BM25 candidates via FTS5 index — sub-millisecond, avoids full table scan.
    // OR-join the query tokens (with prefix) rather than the default implicit-AND phrase match:
    // a natural-language query no longer needs EVERY token present in one chunk to surface
    // candidates. Cosine + BM25 re-rank afterward, so broad recall here only helps. ORDER BY
    // bm25 keeps the 500 cap filled with the *best* matches, not an arbitrary slice.
    const bm25Scores = new Map<number, number>();
    const ftsMatch = this.buildFtsMatch(queryText);
    if (ftsMatch) {
      const ftsRows = this.db.prepare(
        "SELECT rowid, bm25(embeddings_fts) AS bm25 FROM embeddings_fts WHERE embeddings_fts MATCH ? ORDER BY bm25 LIMIT 500"
      ).all(ftsMatch) as { rowid: number; bm25: number }[];
      for (const r of ftsRows) bm25Scores.set(r.rowid, -r.bm25);
    }

    // Step 2: Candidate set = BM25 lexical hits UNION ANN nearest neighbors. The ANN side is the
    // cure for purely conceptual queries (no shared keywords) — true cosine nearest-neighbors via
    // the vec0 index, not the old arbitrary novelty-ordered sample. Both sets are re-ranked by the
    // same cosine+BM25 scoring below, so unioning only improves recall.
    const bm25Rowids = [...bm25Scores.keys()];
    const annHits = queryEmbedding ? this.vectorSearch(queryEmbedding, Math.max(limit * 5, 50)) : [];
    const candidateRowids = new Set<number>([...bm25Rowids, ...annHits.map(h => h.rowid)]);

    // LEXICAL MODE WITH NO KEYWORD HITS MEANS NO RESULTS -- not "here are 500 rows".
    // The novelty-ordered fallback below exists for "the ANN extension is missing but we still have a query
    // vector to re-rank with". Reaching it with neither a vector nor a lexical hit would hand back 500
    // arbitrary rows that a companion reads as recall. An honest empty beats confident noise.
    if (!queryEmbedding && candidateRowids.size === 0) return [];

    let rows: Record<string, unknown>[];
    if (candidateRowids.size > 0) {
      // Cap the IN list well under SQLITE_MAX_VARIABLE_NUMBER (999).
      const ids = [...candidateRowids].slice(0, 900);
      const placeholders = ids.map(() => "?").join(",");
      rows = this.db.prepare(
        `SELECT rowid, * FROM embeddings WHERE rowid IN (${placeholders})`
      ).all(...ids) as Record<string, unknown>[];
    } else {
      // No lexical hits and no ANN (e.g. extension unavailable): novelty-ordered sample fallback.
      rows = this.db.prepare(
        "SELECT rowid, * FROM embeddings ORDER BY novelty_score DESC LIMIT 500"
      ).all() as Record<string, unknown>[];
    }

    if (rows.length === 0) return [];

    // Step 3: Cosine-score candidates and combine with BM25.
    const candidates = rows.map(r => ({ rowid: r.rowid as number, chunk: this.deserialize(r) }));
    // Lexical mode: every cosine is 0, so normV below is a constant and BM25 + the nudges do the ranking.
    // Deliberately NOT a zero vector passed to cosineSimilarity -- that would make every chunk equidistant
    // while still LOOKING like a similarity score to anything downstream.
    const vectorScores = new Map(candidates.map(({ rowid, chunk }) =>
      [rowid, queryEmbedding ? this.cosineSimilarity(queryEmbedding, chunk.embedding) : 0]
    ));

    const vVals = [...vectorScores.values()];
    const vMin = vVals.reduce((a, b) => Math.min(a, b), Infinity);
    const vMax = vVals.reduce((a, b) => Math.max(a, b), -Infinity);
    const vRange = vMax - vMin || 1;
    const bVals = [...bm25Scores.values()];
    const bMax = bVals.length ? bVals.reduce((a, b) => Math.max(a, b), -Infinity) : 1;
    const bRange = bMax > 0 ? bMax : 1;

    // SOMA resonance (EmotionalRAG 2410.23041, takes 1+6): match the affect-at-encoding, graded by
    // distance in valence x arousal space, not binary label equality. Additive nudge only -- never
    // gates recall; unknown/null labels get exactly 0. SB_RESONANCE_WEIGHT tunes; 0 disables.
    const resonanceWeight = Number(process.env.SB_RESONANCE_WEIGHT ?? 0.08);

    // Recency (2026-07-31). Until now this formula had NO time term: `created_at` was in every row
    // returned above and never scored, so a June chunk and a chunk from last night ranked identically
    // at equal cosine. That is how "which episode did we watch last" surfaced a June note about
    // having FINISHED the show. A BOOST for fresh, never a penalty for old -- old material must stay
    // findable when Raziel reaches for it, so nothing ranks lower than it did before this term.
    const recWeight = recencyWeight();
    const recHalfLife = recencyHalfLifeDays();
    const scoredAt = Date.now();

    return candidates
      .map(({ rowid, chunk }) => {
        const normV = ((vectorScores.get(rowid) ?? 0) - vMin) / vRange;
        const rawB = bm25Scores.get(rowid) ?? 0;
        const normB = bm25Scores.size ? rawB / bRange : 0;
        const resonance = emotionResonance(chunk.valence, mood, resonanceWeight);
        // Metamemory reliability (0070, Zikkaron rate_memory + CogCor update_memory_outcome):
        // Laplace-smoothed usefulness, +/-0.05 max swing. Additive nudge -- never gates.
        // Fresh chunks (0/0) get reliability 0.5 -> boost exactly 0.
        const reliability = (chunk.useful_count + 1) / (chunk.useful_count + chunk.useless_count + 2);
        const metamemory = 0.10 * (reliability - 0.5);
        const recency = recencyBoost(chunk.created_at, recWeight, recHalfLife, scoredAt);
        const score = 0.7 * normV + 0.3 * normB + resonance + metamemory + recency;
        // ABSOLUTE relevance, carried alongside the ranking score (2026-08-10).
        //
        // `score` cannot answer "is anything here actually about the query", and never could: `normV` is
        // MIN-MAX NORMALIZED over the candidate set, so the best candidate always normalizes to ~1.0 no
        // matter how unrelated it is. Measured: "quantum chromodynamics lattice gauge theory" -- a subject
        // absent from this vault -- returned pool-1 scores of 0.89/0.81/0.81/0.78, indistinguishable from a
        // real, answerable query, top hit matching on the word "gauge" in "a warm but settling gauge".
        // A threshold on `score` is therefore meaningless BY CONSTRUCTION, and any consumer reading it as
        // confidence is reading a rank position.
        //
        // `cosine` is the raw, un-normalized similarity: comparable across queries and thresholdable.
        // null in lexical mode, where there is no query vector and so no honest similarity to report --
        // deliberately null rather than 0, so "no vector" cannot be misread as "measured, and far away".
        const cosine = queryEmbedding ? (vectorScores.get(rowid) ?? null) : null;
        return { ...chunk, score, cosine };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Exact tag lookup -- the third search shape (2026-07-08): concept search (hybridSearch)
  // and file pull are both approximate/exact-by-path; neither answers "find things tagged X."
  // tags is a JSON array column (better-sqlite3 ships SQLite with json1 built in), so this
  // matches ANY of the given tags via json_each rather than a LIKE scan over the raw string --
  // a tag like "art" won't spuriously match inside a stored tag like "party".
  searchByTags(tags: string[], limit = 20): ChunkRow[] {
    const clean = tags.map(t => t.trim().toLowerCase()).filter(Boolean);
    if (clean.length === 0) return [];
    const clauses = clean.map(() =>
      "EXISTS (SELECT 1 FROM json_each(embeddings.tags) je WHERE LOWER(je.value) = ?)"
    ).join(" OR ");
    const rows = this.db.prepare(
      `SELECT * FROM embeddings WHERE ${clauses} ORDER BY created_at DESC LIMIT ?`
    ).all(...clean, limit) as Record<string, unknown>[];
    return rows.map(r => this.deserialize(r));
  }

  // ── Priority 5: Three-pool surfacing ──────────────────────────────────────────

  // Decay novelty_score by 0.1 for each surfaced chunk, floored by content_type weight.
  // document = heavy (0.3), note/observation/study = medium (0.2), else = light (0.1).
  updateNoveltyScores(chunks: Array<{ id: string; content_type: string }>): void {
    const stmt = this.db.prepare(
      "UPDATE embeddings SET novelty_score = MAX(?, novelty_score - 0.1), last_surfaced_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    this.db.transaction(() => {
      for (const { id, content_type } of chunks) {
        stmt.run(this.noveltyFloor(content_type), id);
      }
    })();
  }

  // Pool 2 -- high novelty: things that haven't surfaced recently.
  noveltySearch(limit: number, excludeIds: string[]): Array<ChunkRow & { score: number }> {
    // Fetch limit + excludeIds.length rows ordered by novelty, then filter in JS.
    // Avoids SQLITE_MAX_VARIABLE_NUMBER (999) being exceeded by a large NOT IN clause
    // as the store grows and excludeIds accumulates pool1 results.
    const fetchLimit = limit + excludeIds.length;
    const excludeSet = new Set(excludeIds);
    const rows = (this.db.prepare(
      `SELECT * FROM embeddings WHERE ${NOT_CHATTER_SQL} ORDER BY novelty_score DESC LIMIT ?`
    ).all(fetchLimit) as Record<string, unknown>[])
      .filter(r => !excludeSet.has(r.id as string));
    return rows.slice(0, limit).map(r => {
      const chunk = this.deserialize(r);
      return { ...chunk, score: chunk.novelty_score };
    });
  }

  // Pool 3 -- edge/serendipity: medium cosine similarity (0.3-0.6), sorted by novelty.
  // Samples from high-novelty rows rather than doing a full table scan — serendipity should
  // surface things that haven't been seen recently anyway, so novelty-ordered sampling is
  // semantically correct and avoids O(n) memory cost.
  edgeSearch(queryEmbedding: number[], limit: number, excludeIds: string[]): Array<ChunkRow & { score: number }> {
    const excludeSet = new Set(excludeIds);
    const fetchLimit = Math.max(excludeIds.length + limit * 20, 200);
    return (this.db.prepare(
      `SELECT * FROM embeddings WHERE ${NOT_CHATTER_SQL} ORDER BY novelty_score DESC LIMIT ?`
    ).all(fetchLimit) as Record<string, unknown>[])
      .map(r => this.deserialize(r))
      .filter(r => !excludeSet.has(r.id))
      .map(chunk => ({ ...chunk, score: this.cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .filter(r => r.score >= 0.3 && r.score <= 0.6)
      .sort((a, b) => b.novelty_score - a.novelty_score)
      .slice(0, limit);
  }

  // Content-type-scoped cosine search. Pure semantic ranking over a single content_type.
  // Used for (a) the guaranteed historical_corpus pool in sb_search so the origin layer always
  // surfaces on concept queries even when recent companion writing out-scores it, and (b) explicit
  // scoped search ("search the corpus for X"). A single content_type is a small slice (corpus ~600
  // rows) so a full cosine scan is cheap and exact — no ANN/BM25 candidate gating needed.
  // `floor` drops weak matches so an irrelevant query doesn't inject off-topic corpus chunks.
  // scanCap bounds memory as the corpus grows: loading every row at large scale is O(N) JSON
  // parse + cosine math; 2000 rows is the practical ceiling before that becomes a GC concern.
  searchByContentType(
    queryEmbedding: number[],
    contentType: string,
    limit: number,
    excludeIds: string[] = [],
    floor: number = 0,
    scanCap = 2000,
  ): Array<ChunkRow & { score: number }> {
    if (limit <= 0) return [];
    const excludeSet = new Set(excludeIds);
    return (this.db.prepare(
      "SELECT * FROM embeddings WHERE content_type = ? LIMIT ?"
    ).all(contentType, scanCap) as Record<string, unknown>[])
      .map(r => this.deserialize(r))
      .filter(r => !excludeSet.has(r.id))
      .map(chunk => ({ ...chunk, score: this.cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .filter(r => r.score >= floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Filtered query for sb_recall — pushes companion, content_type, and LIMIT into SQL
  // rather than loading all rows and slicing in application code.
  queryFiltered(options: { companion: string | null; contentType?: string; limit: number }): ChunkRow[] {
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (options.companion === null) {
      conditions.push("companion IS NULL");
    } else {
      conditions.push("companion = ?");
      bindings.push(options.companion);
    }
    if (options.contentType) {
      conditions.push("content_type = ?");
      bindings.push(options.contentType);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    bindings.push(options.limit);
    return (this.db.prepare(
      `SELECT * FROM embeddings ${where} LIMIT ?`
    ).all(...bindings) as Record<string, unknown>[]).map(r => this.deserialize(r));
  }

  // Build an FTS5 MATCH expression from free text. Tokens are sanitized, lowercased, deduped,
  // quoted (so a token that is itself an FTS operator like "or"/"near" can't break parsing),
  // given a trailing "*" for prefix matching (plural/tense recall), and OR-joined. Common
  // stopwords are dropped only when meaningful tokens remain, so "the spiral" searches "spiral"
  // but "the" alone still matches. Returns "" when there is nothing searchable.
  private buildFtsMatch(queryText: string): string {
    const STOPWORDS = new Set([
      "the","a","an","and","or","but","of","to","in","on","at","for","with","is","are","was",
      "were","be","been","do","did","does","i","we","you","it","that","this","what","about","my",
    ]);
    const tokens = queryText.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "";
    const meaningful = tokens.filter(t => !STOPWORDS.has(t));
    const chosen = meaningful.length > 0 ? meaningful : tokens;
    const unique = [...new Set(chosen)];
    return unique.map(t => `"${t}"*`).join(" OR ");
  }

  private noveltyFloor(contentType: string): number {
    if (contentType === "document") return 0.3;
    if (["note", "observation", "study"].includes(contentType)) return 0.2;
    return 0.1;
  }

  close(): void {
    this.db.close();
  }

  // S3: NaN-safe. A single corrupt embedding element previously poisoned the
  // result, then propagated through hybridSearch reduce min/max normalization.
  // Made non-private so vitest can exercise the guard directly.
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i], bi = b[i];
      if (!Number.isFinite(ai) || !Number.isFinite(bi)) return 0;
      dot += ai * bi;
      magA += ai * ai;
      magB += bi * bi;
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    if (!magA || !magB) return 0;
    const r = dot / (magA * magB);
    return Number.isFinite(r) ? r : 0;
  }

  private deserialize(row: Record<string, unknown>): ChunkRow {
    let embedding: number[];
    let tags: string[];
    try {
      embedding = JSON.parse(row.embedding as string) as number[];
    } catch {
      throw new Error(`VectorStore: corrupt embedding in row ${row.id}: ${row.embedding}`);
    }
    try {
      tags = JSON.parse(row.tags as string) as string[];
    } catch {
      throw new Error(`VectorStore: corrupt tags in row ${row.id}: ${row.tags}`);
    }
    return {
      id: row.id as string,
      vault_path: row.vault_path as string,
      companion: row.companion as string | null,
      content_type: row.content_type as string,
      chunk_text: row.chunk_text as string,
      prefixed_text: row.prefixed_text as string | null,
      section: row.section as string | null,
      chunk_index: row.chunk_index as number | null,
      valence: (row.valence as string | null) ?? null,
      embedding,
      tags,
      created_at: row.created_at as string,
      novelty_score: (row.novelty_score as number) ?? 1.0,
      last_surfaced_at: (row.last_surfaced_at as string | null) ?? null,
      useful_count: (row.useful_count as number) ?? 0,
      useless_count: (row.useless_count as number) ?? 0,
    };
  }

  // ── Metamemory feedback (0070) ────────────────────────────────────────────────

  /**
   * Record recall-outcome feedback for chunks by id. Returns the number of rows
   * actually updated (unknown ids are silently skipped -- feedback on pruned
   * chunks is not an error).
   */
  recordFeedback(ids: string[], useful: boolean): number {
    const col = useful ? "useful_count" : "useless_count";
    const stmt = this.db.prepare(`UPDATE embeddings SET ${col} = ${col} + 1 WHERE id = ?`);
    let updated = 0;
    this.db.transaction(() => {
      for (const id of ids.slice(0, 50)) {
        updated += stmt.run(id).changes;
      }
    })();
    return updated;
  }
}
