import Database from "better-sqlite3";
import { randomUUID } from "crypto";

export interface ChunkInsert {
  vault_path: string;
  companion: string | null;
  content_type: string;
  chunk_text: string;
  embedding: number[];
  tags: string[];
}

export interface ChunkRow extends ChunkInsert {
  id: string;
  created_at: string;
}

export class VectorStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        vault_path TEXT NOT NULL,
        companion TEXT,
        content_type TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_companion ON embeddings(companion);
      CREATE INDEX IF NOT EXISTS idx_vault_path ON embeddings(vault_path);
      CREATE INDEX IF NOT EXISTS idx_content_type ON embeddings(content_type);
    `);
  }

  insert(chunk: ChunkInsert): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO embeddings (id, vault_path, companion, content_type, chunk_text, embedding, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      chunk.vault_path,
      chunk.companion,
      chunk.content_type,
      chunk.chunk_text,
      JSON.stringify(chunk.embedding),
      JSON.stringify(chunk.tags)
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

  getAll(): ChunkRow[] {
    return (this.db.prepare("SELECT * FROM embeddings").all() as Record<string, unknown>[])
      .map(r => this.deserialize(r));
  }

  deleteByPath(vaultPath: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE vault_path = ?").run(vaultPath);
  }

  close(): void {
    this.db.close();
  }

  private deserialize(row: Record<string, unknown>): ChunkRow {
    return {
      ...row,
      embedding: JSON.parse(row.embedding as string),
      tags: JSON.parse(row.tags as string),
    } as ChunkRow;
  }
}
