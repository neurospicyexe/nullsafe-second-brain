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
    if (!cols.includes("prefixed_text")) this.db.prepare("ALTER TABLE embeddings ADD COLUMN prefixed_text TEXT").run();
    if (!cols.includes("section"))       this.db.prepare("ALTER TABLE embeddings ADD COLUMN section TEXT").run();
    if (!cols.includes("chunk_index"))   this.db.prepare("ALTER TABLE embeddings ADD COLUMN chunk_index INTEGER").run();

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
      CREATE TRIGGER IF NOT EXISTS embeddings_ai AFTER INSERT ON embeddings BEGIN
        INSERT INTO embeddings_fts(rowid, prefixed_text) VALUES (new.rowid, new.prefixed_text);
      END
    `).run();
    this.db.prepare(`
      CREATE TRIGGER IF NOT EXISTS embeddings_ad AFTER DELETE ON embeddings BEGIN
        INSERT INTO embeddings_fts(embeddings_fts, rowid, prefixed_text) VALUES ('delete', old.rowid, old.prefixed_text);
      END
    `).run();
    this.db.prepare(`
      CREATE TRIGGER IF NOT EXISTS embeddings_au AFTER UPDATE ON embeddings BEGIN
        INSERT INTO embeddings_fts(embeddings_fts, rowid, prefixed_text) VALUES ('delete', old.rowid, old.prefixed_text);
        INSERT INTO embeddings_fts(rowid, prefixed_text) VALUES (new.rowid, new.prefixed_text);
      END
    `).run();
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
    return (this.db.prepare("SELECT * FROM embeddings WHERE vault_path = ?").all(vaultPath) as Record<string, unknown>[])
      .map(r => this.deserialize(r));
  }

  getAll(): ChunkRow[] {
    return (this.db.prepare("SELECT * FROM embeddings").all() as Record<string, unknown>[])
      .map(r => this.deserialize(r));
  }

  deleteByPath(vaultPath: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE vault_path = ?").run(vaultPath);
  }

  hybridSearch(queryEmbedding: number[], queryText: string, limit: number): Array<ChunkRow & { score: number }> {
    const allRows = (this.db.prepare("SELECT rowid, * FROM embeddings").all() as Record<string, unknown>[])
      .map(r => ({ rowid: r.rowid as number, chunk: this.deserialize(r) }));
    if (allRows.length === 0) return [];

    const rowidToChunk = new Map(allRows.map(r => [r.rowid, r.chunk]));
    const vectorScores = new Map(allRows.map(r => [r.rowid, this.cosineSimilarity(queryEmbedding, r.chunk.embedding)]));

    const bm25Scores = new Map<number, number>();
    const safeQuery = queryText.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
    if (safeQuery) {
      const ftsRows = this.db.prepare(
        "SELECT rowid, bm25(embeddings_fts) AS bm25 FROM embeddings_fts WHERE embeddings_fts MATCH ? LIMIT 500"
      ).all(safeQuery) as { rowid: number; bm25: number }[];
      for (const r of ftsRows) bm25Scores.set(r.rowid, -r.bm25);
    }

    const vVals = [...vectorScores.values()];
    const vMin = Math.min(...vVals), vMax = Math.max(...vVals), vRange = vMax - vMin || 1;
    const bVals = [...bm25Scores.values()];
    const bMin = bVals.length ? Math.min(...bVals) : 0;
    const bMax = bVals.length ? Math.max(...bVals) : 1;
    const bRange = bMax - bMin || 1;

    return [...rowidToChunk.entries()]
      .map(([rowid, chunk]) => {
        const normV = ((vectorScores.get(rowid) ?? 0) - vMin) / vRange;
        const rawB = bm25Scores.get(rowid) ?? bMin;
        const normB = bm25Scores.size ? (rawB - bMin) / bRange : 0;
        const score = 0.7 * normV + 0.3 * normB;
        return { ...chunk, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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
    };
  }
}
