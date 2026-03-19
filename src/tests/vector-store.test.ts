import { describe, it, expect } from "vitest";
import { VectorStore } from "../store/vector-store.js";
import type Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

function makeStore() {
  const dbPath = join(tmpdir(), `vs-test-${Date.now()}.db`);
  const store = new VectorStore(dbPath);
  store.initialize();
  return { store, dbPath };
}

function makeChunk(overrides: Record<string, unknown> = {}) {
  return {
    vault_path: "test/doc.md",
    companion: "drevan",
    content_type: "note",
    chunk_text: "raw chunk text here",
    prefixed_text: "test/doc.md | companion:drevan | note:\n## Heading\nraw chunk text here",
    section: "Heading",
    chunk_index: 0,
    embedding: Array.from({ length: 8 }, (_, i) => i * 0.1),
    tags: [],
    ...overrides,
  };
}

describe("VectorStore schema", () => {
  it("initializes without error and has new columns", () => {
    const { store, dbPath } = makeStore();
    const db = (store as any).db as Database.Database;
    const cols = db.prepare("PRAGMA table_info(embeddings)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain("prefixed_text");
    expect(names).toContain("section");
    expect(names).toContain("chunk_index");
    store.close();
    rmSync(dbPath);
  });

  it("creates embeddings_fts virtual table", () => {
    const { store, dbPath } = makeStore();
    const db = (store as any).db as Database.Database;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain("embeddings_fts");
    store.close();
    rmSync(dbPath);
  });
});

describe("VectorStore.insert (new fields)", () => {
  it("stores prefixed_text, section, chunk_index", () => {
    const { store, dbPath } = makeStore();
    const id = store.insert(makeChunk() as any);
    const row = store.getById(id);
    expect(row?.prefixed_text).toBe("test/doc.md | companion:drevan | note:\n## Heading\nraw chunk text here");
    expect(row?.section).toBe("Heading");
    expect(row?.chunk_index).toBe(0);
    store.close();
    rmSync(dbPath);
  });

  it("FTS5 table receives the inserted row", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({ prefixed_text: "unique phrase xyzzy" }) as any);
    const db = (store as any).db as Database.Database;
    const results = db.prepare("SELECT * FROM embeddings_fts WHERE embeddings_fts MATCH ?").all("xyzzy");
    expect(results.length).toBeGreaterThan(0);
    store.close();
    rmSync(dbPath);
  });

  it("FTS5 table removes row when chunk is deleted", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({ vault_path: "to-delete.md", prefixed_text: "deleteme phrase abc123" }) as any);
    store.deleteByPath("to-delete.md");
    const db = (store as any).db as Database.Database;
    const results = db.prepare("SELECT * FROM embeddings_fts WHERE embeddings_fts MATCH ?").all("abc123");
    expect(results.length).toBe(0);
    store.close();
    rmSync(dbPath);
  });
});

describe("VectorStore.filterByPath", () => {
  it("returns only rows for the given vault_path", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({ vault_path: "a.md", chunk_index: 0 }) as any);
    store.insert(makeChunk({ vault_path: "a.md", chunk_index: 1 }) as any);
    store.insert(makeChunk({ vault_path: "b.md", chunk_index: 0 }) as any);
    const rows = store.filterByPath("a.md");
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.vault_path === "a.md")).toBe(true);
    store.close();
    rmSync(dbPath);
  });
});

describe("VectorStore.hybridSearch", () => {
  it("returns ranked results with keyword-matching chunk first", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({
      vault_path: "kw.md",
      prefixed_text: "rosie limping diagnosis vet",
      chunk_text: "rosie was limping at the vet",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    }) as any);
    store.insert(makeChunk({
      vault_path: "vec.md",
      prefixed_text: "something else entirely",
      chunk_text: "unrelated content",
      embedding: [0.99, 0, 0, 0, 0, 0, 0, 0],
    }) as any);
    const results = store.hybridSearch([1, 0, 0, 0, 0, 0, 0, 0], "rosie limping", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk_text).toContain("rosie");
    store.close();
    rmSync(dbPath);
  });
});
