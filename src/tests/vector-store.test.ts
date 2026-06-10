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
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("creates embeddings_fts virtual table", () => {
    const { store, dbPath } = makeStore();
    const db = (store as any).db as Database.Database;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain("embeddings_fts");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });
});

describe("VectorStore prefixed_text self-heal", () => {
  it("backfills NULL prefixed_text from chunk_text on initialize, making the chunk keyword-searchable", () => {
    const { store, dbPath } = makeStore();
    // Simulate the old ingestion-pipeline path: insert with NO prefixed_text -> NULL -> not in FTS.
    store.insert(makeChunk({
      vault_path: "rag/growth_journal/7",
      prefixed_text: undefined,
      chunk_text: "drevan noticed a recurring pattern about thresholds",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    }) as any);
    const db = (store as any).db as Database.Database;
    // Before heal: invisible to FTS.
    const before = db.prepare("SELECT count(*) n FROM embeddings_fts WHERE embeddings_fts MATCH ?").get("thresholds") as { n: number };
    expect(before.n).toBe(0);
    // Re-run initialize (idempotent) -> heal backfills prefixed_text and the UPDATE trigger syncs FTS.
    store.initialize();
    const after = db.prepare("SELECT count(*) n FROM embeddings_fts WHERE embeddings_fts MATCH ?").get("thresholds") as { n: number };
    expect(after.n).toBe(1);
    // And it now surfaces via hybridSearch keyword recall.
    const results = store.hybridSearch([1, 0, 0, 0, 0, 0, 0, 0], "thresholds", 10);
    expect(results.map(r => r.vault_path)).toContain("rag/growth_journal/7");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
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
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("FTS5 table receives the inserted row", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({ prefixed_text: "unique phrase xyzzy" }) as any);
    const db = (store as any).db as Database.Database;
    const results = db.prepare("SELECT * FROM embeddings_fts WHERE embeddings_fts MATCH ?").all("xyzzy");
    expect(results.length).toBeGreaterThan(0);
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("FTS5 table removes row when chunk is deleted", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({ vault_path: "to-delete.md", prefixed_text: "deleteme phrase abc123" }) as any);
    store.deleteByPath("to-delete.md");
    const db = (store as any).db as Database.Database;
    const results = db.prepare("SELECT * FROM embeddings_fts WHERE embeddings_fts MATCH ?").all("abc123");
    expect(results.length).toBe(0);
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
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
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
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
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("surfaces partial matches: query tokens split across chunks (OR recall, not implicit-AND)", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({
      vault_path: "moto.md",
      prefixed_text: "motorcycle ride through rome",
      chunk_text: "motorcycle ride through rome",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    }) as any);
    store.insert(makeChunk({
      vault_path: "garage.md",
      prefixed_text: "quiet garage with tools",
      chunk_text: "quiet garage with tools",
      embedding: [0, 1, 0, 0, 0, 0, 0, 0],
    }) as any);
    // No single chunk contains BOTH "motorcycle" and "garage" -- under the old implicit-AND
    // phrase match this returned zero BM25 candidates. OR-recall must surface both.
    const results = store.hybridSearch([1, 0, 0, 0, 0, 0, 0, 0], "motorcycle garage", 10);
    const paths = results.map(r => r.vault_path);
    expect(paths).toContain("moto.md");
    expect(paths).toContain("garage.md");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("surfaces a purely conceptual match: query shares NO keywords, found via ANN vector index", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({
      vault_path: "alpha.md",
      prefixed_text: "alpha", chunk_text: "alpha",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    }) as any);
    store.insert(makeChunk({
      vault_path: "bravo.md",
      prefixed_text: "bravo", chunk_text: "bravo",
      embedding: [0, 1, 0, 0, 0, 0, 0, 0],
    }) as any);
    // Query text matches NOTHING lexically (zero BM25 hits), but its embedding is near alpha.
    // Old behavior: novelty-ordered sample, arbitrary. New: ANN returns alpha first.
    const results = store.hybridSearch([0.96, 0.05, 0, 0, 0, 0, 0, 0], "zzzznomatchanywhere", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].vault_path).toBe("alpha.md");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("ANN backfill on initialize indexes pre-existing embeddings (the upgrade path)", () => {
    const { store, dbPath } = makeStore();
    const db = (store as any).db as Database.Database;
    // Insert directly into embeddings, bypassing insert()'s vec sync (simulates rows that
    // existed before sqlite-vec was added). Then initialize() must backfill the ANN index.
    db.prepare(
      "INSERT INTO embeddings (id, vault_path, companion, content_type, chunk_text, prefixed_text, embedding, tags) VALUES (?,?,?,?,?,?,?,?)"
    ).run("legacy1", "legacy.md", null, "document", "legacy text", "legacy text", JSON.stringify([0, 0, 1, 0, 0, 0, 0, 0]), "[]");
    store.initialize();
    const hits = store.vectorSearch([0, 0, 1, 0, 0, 0, 0, 0], 5);
    expect(hits.length).toBe(1);
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("ignores stopwords when meaningful tokens remain", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({
      vault_path: "spiral.md",
      prefixed_text: "the spiral work we did",
      chunk_text: "the spiral work we did",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    }) as any);
    // "what about the spiral" -> only "spiral" is meaningful; must still match.
    const results = store.hybridSearch([1, 0, 0, 0, 0, 0, 0, 0], "what about the spiral", 10);
    expect(results.map(r => r.vault_path)).toContain("spiral.md");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });
});

describe("VectorStore.searchByContentType", () => {
  it("returns only the requested content_type, ranked by cosine, respecting floor + excludeIds", () => {
    const { store, dbPath } = makeStore();
    const corpusNear = store.insert(makeChunk({
      vault_path: "rag/historical_corpus/a.md/0", content_type: "historical_corpus",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    }) as any);
    store.insert(makeChunk({
      vault_path: "rag/historical_corpus/b.md/0", content_type: "historical_corpus",
      embedding: [0, 1, 0, 0, 0, 0, 0, 0], // orthogonal -> cosine 0, below any positive floor
    }) as any);
    store.insert(makeChunk({
      vault_path: "rag/growth_journal/x", content_type: "growth_journal",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0], // same vector but wrong content_type -> excluded
    }) as any);

    const q = [1, 0, 0, 0, 0, 0, 0, 0];
    const hits = store.searchByContentType(q, "historical_corpus", 10, [], 0.5);
    // only the near corpus chunk clears the 0.5 floor; the orthogonal one and the journal are out
    expect(hits.map(h => h.vault_path)).toEqual(["rag/historical_corpus/a.md/0"]);
    expect(hits.every(h => h.content_type === "historical_corpus")).toBe(true);

    // excludeIds drops an already-surfaced chunk
    const excluded = store.searchByContentType(q, "historical_corpus", 10, [corpusNear], 0.5);
    expect(excluded).toHaveLength(0);
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });
});

describe("VectorStore.dedupeByPathAndIndex", () => {
  it("removes same-(vault_path,chunk_index) dupes keeping newest, preserves real multi-chunk files", () => {
    const { store, dbPath } = makeStore();
    // A legitimately multi-chunk file: distinct chunk_index -> must be untouched.
    store.insert(makeChunk({ vault_path: "doc.md", chunk_index: 0, chunk_text: "c0" }) as any);
    store.insert(makeChunk({ vault_path: "doc.md", chunk_index: 1, chunk_text: "c1" }) as any);
    // A re-embedded single record: same (vault_path, chunk_index) twice -> one is a dupe.
    store.insert(makeChunk({ vault_path: "rag/note/7", chunk_index: 0, chunk_text: "old wrap" }) as any);
    const newestId = store.insert(makeChunk({ vault_path: "rag/note/7", chunk_index: 0, chunk_text: "new wrap" }) as any);

    const dryCount = store.dedupeByPathAndIndex(true);
    expect(dryCount).toBe(1); // dry run reports, deletes nothing
    expect(store.filterByPath("rag/note/7")).toHaveLength(2);

    const removed = store.dedupeByPathAndIndex();
    expect(removed).toBe(1);
    // multi-chunk file intact
    expect(store.filterByPath("doc.md")).toHaveLength(2);
    // dupe collapsed to the newest row
    const remaining = store.filterByPath("rag/note/7");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(newestId);
    expect(remaining[0].chunk_text).toBe("new wrap");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });
});

describe("VectorStore SOMA resonance (valence boost)", () => {
  it("adds valence column on initialize", () => {
    const { store, dbPath } = makeStore();
    const db = (store as any).db as Database.Database;
    const names = (db.prepare("PRAGMA table_info(embeddings)").all() as { name: string }[]).map(c => c.name);
    expect(names).toContain("valence");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("boosts matching-valence chunks when mood is passed, additively", () => {
    const { store, dbPath } = makeStore();
    // Two chunks identical in every scoring dimension except valence.
    store.insert(makeChunk({
      vault_path: "test/warm.md",
      chunk_text: "spiral threshold work in the garage",
      prefixed_text: "spiral threshold work in the garage",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      valence: "tender",
    }) as any);
    store.insert(makeChunk({
      vault_path: "test/flat.md",
      chunk_text: "spiral threshold work in the garage",
      prefixed_text: "spiral threshold work in the garage",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      valence: null,
    }) as any);

    const withMood = store.hybridSearch([1, 0, 0, 0, 0, 0, 0, 0], "spiral threshold", 2, "Tender");
    expect(withMood[0].vault_path).toBe("test/warm.md");
    expect(withMood[0].score).toBeGreaterThan(withMood[1].score);

    // Without mood: identical scores, no boost applied.
    const noMood = store.hybridSearch([1, 0, 0, 0, 0, 0, 0, 0], "spiral threshold", 2);
    expect(noMood[0].score).toBeCloseTo(noMood[1].score, 10);

    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("never gates recall -- null-valence chunks still surface with mood passed", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({
      vault_path: "test/only.md",
      chunk_text: "rosie limping at the perimeter",
      prefixed_text: "rosie limping at the perimeter",
      embedding: [0, 1, 0, 0, 0, 0, 0, 0],
      valence: null,
    }) as any);
    const results = store.hybridSearch([0, 1, 0, 0, 0, 0, 0, 0], "rosie limping", 5, "tender");
    expect(results.length).toBe(1);
    expect(results[0].vault_path).toBe("test/only.md");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });
});
