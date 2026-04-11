import Database from "better-sqlite3";
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

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
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
  }

  insert(chunk: ChunkInsert): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO embeddings
        (id, vault_path, companion, content_type, chunk_text, prefixed_text, section, chunk_index, embedding, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, chunk.vault_path, chunk.companion, chunk.content_type, chunk.chunk_text,
      chunk.prefixed_text ?? null, chunk.section ?? null, chunk.chunk_index ?? null,
      JSON.stringify(chunk.embedding), JSON.stringify(chunk.tags)
    );
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
    this.db.prepare("DELETE FROM embeddings WHERE vault_path = ?").run(vaultPath);
  }

  existsByPath(path: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM embeddings WHERE vault_path = ? LIMIT 1').get(path)
    return row !== undefined
  }

  hybridSearch(queryEmbedding: number[], queryText: string, limit: number): Array<ChunkRow & { score: number }> {
    // Step 1: BM25 candidates via FTS5 index — sub-millisecond, avoids full table scan.
    const bm25Scores = new Map<number, number>();
    const safeQuery = queryText.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
    if (safeQuery) {
      const ftsRows = this.db.prepare(
        "SELECT rowid, bm25(embeddings_fts) AS bm25 FROM embeddings_fts WHERE embeddings_fts MATCH ? LIMIT 500"
      ).all(safeQuery) as { rowid: number; bm25: number }[];
      for (const r of ftsRows) bm25Scores.set(r.rowid, -r.bm25);
    }

    // Step 2: Load only candidate rows. BM25 hits are the primary candidate set.
    // If no BM25 matches (pure semantic / no text), fall back to a novelty-ordered sample
    // rather than a full scan — avoids O(n) memory growth as the index scales.
    let rows: Record<string, unknown>[];
    const bm25Rowids = [...bm25Scores.keys()];
    if (bm25Rowids.length > 0) {
      const placeholders = bm25Rowids.map(() => "?").join(",");
      rows = this.db.prepare(
        `SELECT rowid, * FROM embeddings WHERE rowid IN (${placeholders})`
      ).all(...bm25Rowids) as Record<string, unknown>[];
    } else {
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

  private noveltyFloor(contentType: string): number {
    if (contentType === "document") return 0.3;
    if (["note", "observation", "study"].includes(contentType)) return 0.2;
    return 0.1;
  }

  close(): void {
    this.db.close();
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    return magA && magB ? dot / (magA * magB) : 0;
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
