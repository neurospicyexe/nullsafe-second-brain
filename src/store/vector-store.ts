import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "crypto";

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
        (id, vault_path, companion, content_type, chunk_text, prefixed_text, section, chunk_index, embedding, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, chunk.vault_path, chunk.companion, chunk.content_type, chunk.chunk_text,
      chunk.prefixed_text ?? null, chunk.section ?? null, chunk.chunk_index ?? null,
      JSON.stringify(chunk.embedding), JSON.stringify(chunk.tags)
    );

    // Keep the ANN index in sync. rowid must be bound as BigInt for vec0 (better-sqlite3 binds
    // plain JS numbers as REAL, which vec0 rejects for its integer primary key). Non-fatal.
    if (this.vecEnabled && Array.isArray(chunk.embedding) && chunk.embedding.length > 0
        && this.ensureVecTable(chunk.embedding.length)) {
      try {
        this.db.prepare("INSERT INTO vec_embeddings(rowid, embedding) VALUES (?, ?)")
          .run(BigInt(info.lastInsertRowid), JSON.stringify(chunk.embedding));
      } catch (e) {
        console.error("[vector-store] ANN insert sync failed (non-fatal):", e);
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

  existsByPath(path: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM embeddings WHERE vault_path = ? LIMIT 1').get(path)
    return row !== undefined
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

  hybridSearch(queryEmbedding: number[], queryText: string, limit: number): Array<ChunkRow & { score: number }> {
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
    const annHits = this.vectorSearch(queryEmbedding, Math.max(limit * 5, 50));
    const candidateRowids = new Set<number>([...bm25Rowids, ...annHits.map(h => h.rowid)]);

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
    const vectorScores = new Map(candidates.map(({ rowid, chunk }) =>
      [rowid, this.cosineSimilarity(queryEmbedding, chunk.embedding)]
    ));

    const vVals = [...vectorScores.values()];
    const vMin = vVals.reduce((a, b) => Math.min(a, b), Infinity);
    const vMax = vVals.reduce((a, b) => Math.max(a, b), -Infinity);
    const vRange = vMax - vMin || 1;
    const bVals = [...bm25Scores.values()];
    const bMax = bVals.length ? bVals.reduce((a, b) => Math.max(a, b), -Infinity) : 1;
    const bRange = bMax > 0 ? bMax : 1;

    return candidates
      .map(({ rowid, chunk }) => {
        const normV = ((vectorScores.get(rowid) ?? 0) - vMin) / vRange;
        const rawB = bm25Scores.get(rowid) ?? 0;
        const normB = bm25Scores.size ? rawB / bRange : 0;
        const score = 0.7 * normV + 0.3 * normB;
        return { ...chunk, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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
      "SELECT * FROM embeddings ORDER BY novelty_score DESC LIMIT ?"
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
      "SELECT * FROM embeddings ORDER BY novelty_score DESC LIMIT ?"
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
  searchByContentType(
    queryEmbedding: number[],
    contentType: string,
    limit: number,
    excludeIds: string[] = [],
    floor: number = 0,
  ): Array<ChunkRow & { score: number }> {
    if (limit <= 0) return [];
    const excludeSet = new Set(excludeIds);
    return (this.db.prepare(
      "SELECT * FROM embeddings WHERE content_type = ?"
    ).all(contentType) as Record<string, unknown>[])
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
      embedding,
      tags,
      created_at: row.created_at as string,
      novelty_score: (row.novelty_score as number) ?? 1.0,
      last_surfaced_at: (row.last_surfaced_at as string | null) ?? null,
    };
  }
}
