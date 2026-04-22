# Contextual Retrieval Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the second-brain vector store to return only relevant excerpts instead of full documents, using paragraph-aware chunking, rule-based context prefixes, and hybrid vector+FTS5 search with per-document deduplication.

**Architecture:** New columns are added to the existing `embeddings` table additively (no data loss). A FTS5 virtual table + three triggers keep keyword search in sync automatically. New writes immediately get all features; old rows continue working via vector search only.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite FTS5), vitest, existing OpenAI embedder

**Spec:** `docs/superpowers/specs/2026-03-18-contextual-retrieval-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/store/vector-store.ts` | Modify | Schema migration, FTS5 table+triggers, `filterByPath()`, `hybridSearch()` |
| `src/indexer.ts` | Modify | Replace `chunkText` with `paragraphChunk` + `contextPrefix`, pass new fields to store |
| `src/tools/retrieval.ts` | Modify | Use `hybridSearch()`, add per-doc dedup in `sb_search` |
| `src/tools/system.ts` | Modify | Add `embedder` param to `buildSystemTools`, add `query?` to `sb_read` |
| `src/server.ts` | Modify | Pass `embedder` to `buildSystemTools()` |
| `src/tests/vector-store.test.ts` | Create | Schema, insert, filterByPath, hybridSearch, dedup |
| `src/tests/indexer.test.ts` | Create | paragraphChunk, contextPrefix, section extraction |

---

## Task 1: Schema Migration + FTS5

**Files:**
- Modify: `src/store/vector-store.ts`
- Create: `src/tests/vector-store.test.ts`

### What you need to know

The `embeddings` table is defined in `VectorStore.initialize()`. `ChunkInsert` and `ChunkRow` are the interfaces for writing and reading rows. The `insert()` method stores one chunk. `deleteByPath()` removes all chunks for a vault path.

FTS5 in SQLite is a full-text search extension. We use a content-based FTS5 table backed by `embeddings`, kept in sync via three triggers created in `initialize()`. `better-sqlite3` supports FTS5 natively.

SQLite FTS5 BM25 returns negative floats (more negative = more relevant). Negate before combining with cosine scores, then min-max normalize both to [0,1] before merging.

`better-sqlite3` exposes SQLite rowids on every row. The FTS5 query returns `rowid` values -- use `SELECT rowid, * FROM embeddings` so rows can be joined against FTS5 results by rowid.

- [ ] **Step 1: Write failing tests for schema migration**

Create `src/tests/vector-store.test.ts`:

```typescript
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
    rmSync(dbPath);
  });

  it("creates embeddings_fts virtual table", () => {
    const { store, dbPath } = makeStore();
    const db = (store as any).db as Database.Database;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain("embeddings_fts");
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
    rmSync(dbPath);
  });

  it("FTS5 table receives the inserted row", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({ prefixed_text: "unique phrase xyzzy" }) as any);
    const db = (store as any).db as Database.Database;
    const results = db.prepare("SELECT * FROM embeddings_fts WHERE embeddings_fts MATCH ?").all("xyzzy");
    expect(results.length).toBeGreaterThan(0);
    rmSync(dbPath);
  });

  it("FTS5 table removes row when chunk is deleted", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk({ vault_path: "to-delete.md", prefixed_text: "deleteme phrase abc123" }) as any);
    store.deleteByPath("to-delete.md");
    const db = (store as any).db as Database.Database;
    const results = db.prepare("SELECT * FROM embeddings_fts WHERE embeddings_fts MATCH ?").all("abc123");
    expect(results.length).toBe(0);
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
    rmSync(dbPath);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd C:/dev/nullsafe-second-brain && npm test -- src/tests/vector-store.test.ts
```

Expected: failures on missing columns, missing `filterByPath`, missing `hybridSearch`.

- [ ] **Step 3: Update `ChunkInsert` and `ChunkRow` interfaces**

```typescript
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
```

- [ ] **Step 4: Replace `initialize()` body**

Use `prepare().run()` per statement (not multi-statement strings). The additive migration uses `PRAGMA table_info` before `ALTER TABLE`:

```typescript
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

  // Additive migration: add columns only if absent
  const cols = (this.db.prepare("PRAGMA table_info(embeddings)").all() as { name: string }[]).map(c => c.name);
  // Note: chunk_text already exists in the original schema -- do NOT add it.
  // Only three new columns are being added:
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
```

- [ ] **Step 5: Update `insert()` to write new columns**

```typescript
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
```

- [ ] **Step 6: Update `deserialize()` to include new fields**

Add to the return object:

```typescript
prefixed_text: row.prefixed_text as string | null,
section: row.section as string | null,
chunk_index: row.chunk_index as number | null,
```

- [ ] **Step 7: Add `filterByPath()` method**

```typescript
filterByPath(vaultPath: string): ChunkRow[] {
  return (this.db.prepare("SELECT * FROM embeddings WHERE vault_path = ?").all(vaultPath) as Record<string, unknown>[])
    .map(r => this.deserialize(r));
}
```

- [ ] **Step 8: Add private `cosineSimilarity()` method**

```typescript
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
```

- [ ] **Step 9: Add `hybridSearch()` method**

> **Known limitation (M3 in spec):** `hybridSearch` loads all rows into memory before scoring. This is accepted for current scale. Do not attempt to fix this -- it is a tracked future item. If you see a test store with thousands of rows, this is expected behavior.

```typescript
hybridSearch(queryEmbedding: number[], queryText: string, limit: number): ChunkRow[] {
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
    for (const r of ftsRows) bm25Scores.set(r.rowid, -r.bm25); // negate: FTS5 negative = relevant
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
// hybridSearch returns Array<ChunkRow & { score: number }> -- score is the combined normalized value
```

- [ ] **Step 10: Run tests**

```bash
cd C:/dev/nullsafe-second-brain && npm test -- src/tests/vector-store.test.ts
```

Expected: all passing.

- [ ] **Step 11: Commit**

```bash
git add src/store/vector-store.ts src/tests/vector-store.test.ts
git commit -m "feat(store): FTS5 hybrid search, context columns, filterByPath, hybridSearch"
```

---

## Task 2: Paragraph-Aware Chunking + Context Prefix

**Files:**
- Modify: `src/indexer.ts`
- Create: `src/tests/indexer.test.ts`

### What you need to know

`indexer.ts` has a module-private `chunkText()` -- remove it. `Indexer.indexContent()` calls it -- update to call `paragraphChunk`. Export `paragraphChunk` and `contextPrefix` for tests. The `ChunkInsert` interface now accepts the new fields -- fill them here.

Heading detection: a line matching `/^#{1,3}\s+(.+)/` is a heading. Track the most recent heading as paragraphs are accumulated. A chunk inherits the heading that was active when the window opened.

- [ ] **Step 1: Write failing tests**

Create `src/tests/indexer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { paragraphChunk, contextPrefix } from "../indexer.js";

describe("paragraphChunk", () => {
  it("splits on double newlines", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird.";
    const chunks = paragraphChunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    const combined = chunks.map(c => c.text).join(" ");
    expect(combined).toContain("First paragraph");
    expect(combined).toContain("Second paragraph");
  });

  it("keeps chunks under maxChars", () => {
    const chunks = paragraphChunk("word ".repeat(500), 200, 0);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(220);
  });

  it("overlaps: second chunk starts with tail of first", () => {
    const text = "A".repeat(150) + "\n\n" + "B".repeat(150);
    const chunks = paragraphChunk(text, 160, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].text.startsWith("A".repeat(40))).toBe(true);
  });

  it("assigns chunk_index sequentially from 0", () => {
    const chunks = paragraphChunk("para one\n\npara two\n\npara three");
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("returns empty array for blank input", () => {
    expect(paragraphChunk("")).toEqual([]);
    expect(paragraphChunk("   \n\n  ")).toEqual([]);
  });

  it("extracts section heading into chunk.section", () => {
    const text = "## My Section\n\nContent under section.\n\nMore content.";
    const chunks = paragraphChunk(text);
    const contentChunks = chunks.filter(c => c.text.includes("Content") || c.text.includes("More"));
    expect(contentChunks.every(c => c.section === "My Section")).toBe(true);
  });

  it("section is empty string when no heading precedes chunk", () => {
    expect(paragraphChunk("Just a paragraph.")[0].section).toBe("");
  });
});

describe("contextPrefix", () => {
  it("includes path, companion, contentType, and section", () => {
    const p = contextPrefix({ path: "Companions/Drevan/rosie.md", companion: "drevan", contentType: "health", section: "2024 Diagnosis" });
    expect(p).toContain("Companions/Drevan/rosie.md");
    expect(p).toContain("companion:drevan");
    expect(p).toContain("health");
    expect(p).toContain("2024 Diagnosis");
  });

  it("omits companion field when null", () => {
    const p = contextPrefix({ path: "a.md", companion: null, contentType: "study", section: "" });
    expect(p).not.toContain("companion:");
  });

  it("omits section line when section is empty", () => {
    const p = contextPrefix({ path: "a.md", companion: null, contentType: "note", section: "" });
    expect(p).not.toContain("##");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd C:/dev/nullsafe-second-brain && npm test -- src/tests/indexer.test.ts
```

Expected: import errors -- `paragraphChunk` and `contextPrefix` not exported.

- [ ] **Step 3: Add `paragraphChunk` and `contextPrefix` to `src/indexer.ts`**

Remove the existing `chunkText` function. Add these exports above the `Indexer` class:

```typescript
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

  const emit = () => {
    const trimmed = window.trim();
    if (!trimmed) return;
    results.push({ text: trimmed, section: windowSection, index: chunkIndex++ });
    window = trimmed.slice(-overlap); // overlap: trailing chars become start of next window
    windowSection = currentSection;
  };

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) currentSection = headingMatch[1].trim();

    if (window && window.length + trimmed.length + 2 > maxChars) emit();

    if (trimmed.length > maxChars) {
      for (const sentence of trimmed.split(/(?<=\. )/)) {
        if (window && window.length + sentence.length + 1 > maxChars) emit();
        window += (window ? " " : "") + sentence;
        if (!windowSection) windowSection = currentSection;
      }
    } else {
      window += (window ? "\n\n" : "") + trimmed;
      if (!windowSection) windowSection = currentSection;
    }
  }

  if (window.trim()) emit();
  return results;
}

export function contextPrefix(meta: { path: string; companion: string | null; contentType: string; section: string }): string {
  const parts = [meta.path];
  if (meta.companion) parts.push(`companion:${meta.companion}`);
  parts.push(meta.contentType);
  const sectionLine = meta.section ? `\n## ${meta.section}` : "";
  return `${parts.join(" | ")}:${sectionLine}\n`;
}
```

- [ ] **Step 4: Update `Indexer.indexContent()` to use new functions**

Replace the body of `indexContent`:

```typescript
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
  for (let i = 0; i < chunks.length; i++) {
    this.store.insert({
      vault_path: vaultPath, companion, content_type,
      chunk_text: chunks[i].text,
      prefixed_text: prefixedTexts[i],
      section: chunks[i].section,
      chunk_index: chunks[i].index,
      embedding: embeddings[i],
      tags,
    });
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd C:/dev/nullsafe-second-brain && npm test -- src/tests/indexer.test.ts
```

Expected: all passing.

- [ ] **Step 6: Run all tests**

```bash
cd C:/dev/nullsafe-second-brain && npm test
```

Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add src/indexer.ts src/tests/indexer.test.ts
git commit -m "feat(indexer): paragraph-aware chunking with overlap and context prefix"
```

---

## Task 3: Hybrid Search + Per-Doc Dedup in `sb_search`

**Files:**
- Modify: `src/tools/retrieval.ts`

### What you need to know

`retrieval.ts` currently calls `store.getAll()` and does cosine similarity inline. Replace `sb_search` to delegate to `store.hybridSearch()`. Apply per-doc dedup after: iterate results in score order, keep a count per `vault_path`, stop adding a path's chunks once count reaches 2.

Over-fetch by 5x so dedup has enough candidates to fill the final limit after filtering.

The local `cosineSimilarity` function in `retrieval.ts` may still be used by `sb_recall` -- check before removing it.

- [ ] **Step 1: Replace `sb_search` in `src/tools/retrieval.ts`**

```typescript
async sb_search(args: { query: string; limit?: number }) {
  const limit = args.limit ?? 10;
  const queryEmbedding = await embedder.embed(args.query);
  // hybridSearch returns Array<ChunkRow & { score: number }>
  const ranked = store.hybridSearch(queryEmbedding, args.query, limit * 5);

  const seen = new Map<string, number>();
  const deduped: typeof ranked = [];
  for (const chunk of ranked) {
    const count = seen.get(chunk.vault_path) ?? 0;
    if (count < 2) {
      deduped.push(chunk);
      seen.set(chunk.vault_path, count + 1);
    }
    if (deduped.length >= limit) break;
  }

  return {
    chunks: deduped.map(c => ({
      chunk_text: c.chunk_text,
      section: c.section,
      vault_path: c.vault_path,
      score: c.score,
    })),
  };
},
```

- [ ] **Step 2: Run all tests**

```bash
cd C:/dev/nullsafe-second-brain && npm test
```

Expected: all passing.

- [ ] **Step 3: Commit**

```bash
git add src/tools/retrieval.ts
git commit -m "feat(retrieval): hybrid search with per-doc dedup in sb_search"
```

---

## Task 4: Query-Aware `sb_read` + Embedder Wiring

**Files:**
- Modify: `src/tools/system.ts`
- Modify: `src/server.ts`

### What you need to know

`buildSystemTools` needs a 4th param `embedder: Embedder`. `server.ts` has `embedder` in scope already.

`sb_read` without `query` returns full content unchanged. With `query`: call `store.filterByPath(path)`, embed the query, rank by cosine similarity, return top 3 as `{ section, text }`.

`sb_index_rebuild` with empty `paths` collects distinct `vault_path` values from `store.getAll()` and re-indexes each.

`sb_read` tool schema in `server.ts` needs `query: z.string().optional()` added.

- [ ] **Step 1: Add `embedder` import and param to `buildSystemTools` in `src/tools/system.ts`**

```typescript
import type { Embedder } from "../embeddings/embedder.js";

export function buildSystemTools(
  store: VectorStore,
  indexer: Indexer,
  adapter: VaultAdapter,
  embedder: Embedder,
) {
```

- [ ] **Step 2: Replace `sb_read` implementation**

```typescript
async sb_read(args: { path: string; query?: string }) {
  if (!args.query) {
    const content = await adapter.read(args.path);
    return { path: args.path, content };
  }
  const chunks = store.filterByPath(args.path);
  if (chunks.length === 0) {
    const content = await adapter.read(args.path);
    return { path: args.path, content };
  }
  const queryEmbedding = await embedder.embed(args.query);
  function sim(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, mA = 0, mB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; mA += a[i]*a[i]; mB += b[i]*b[i]; }
    return Math.sqrt(mA) && Math.sqrt(mB) ? dot / (Math.sqrt(mA) * Math.sqrt(mB)) : 0;
  }
  const excerpts = chunks
    .map(c => ({ chunk: c, score: sim(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(r => ({ section: r.chunk.section ?? "", text: r.chunk.chunk_text }));
  return { path: args.path, excerpts };
},
```

- [ ] **Step 3: Verify `sb_index_rebuild` signature -- no changes needed**

The spec explicitly rules out a rebuild-all mode (partial-state risk on interruption). Keep the existing `paths: string[]` requirement. An empty array returns `{ rebuilt: 0 }` -- no implicit full rebuild. The existing implementation is correct; no code change required for this step. Just confirm the signature matches:

```typescript
async sb_index_rebuild(args: { paths: string[] }) {
  for (const path of args.paths) await indexer.reindex(path);
  return { rebuilt: args.paths.length };
},
```

- [ ] **Step 4: Pass `embedder` to `buildSystemTools` in `src/server.ts`**

Find `const system = buildSystemTools(store, indexer, adapter)` and change to:

```typescript
const system = buildSystemTools(store, indexer, adapter, embedder);
```

- [ ] **Step 5: Update `sb_read` tool schema in `src/server.ts`**

Find the `server.tool("sb_read", ...)` registration and update description + schema:

```typescript
server.tool(
  "sb_read",
  "Read a vault file. Pass query to return only the most relevant excerpts (up to 3) instead of the full file -- use this for large files to avoid flooding context.",
  { path: z.string(), query: z.string().optional() },
  (args) => system.sb_read(args).then(ok)
);
```

- [ ] **Step 6: Run all tests**

```bash
cd C:/dev/nullsafe-second-brain && npm test
```

Expected: all passing.

- [ ] **Step 7: Build**

```bash
cd C:/dev/nullsafe-second-brain && npm run build
```

Expected: zero TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/tools/system.ts src/server.ts
git commit -m "feat(system): query-aware sb_read, embedder wiring"
```

---

## Task 5: Deploy to VPS

- [ ] **Step 1: Push**

```bash
cd C:/dev/nullsafe-second-brain && git push
```

- [ ] **Step 2: SSH, pull, build, restart**

```bash
ssh <vps-user>@<vps-host>
cd ~/nullsafe-second-brain && git pull && npm install && npm run build
sudo systemctl restart second-brain && sudo systemctl status second-brain
```

Expected: `active (running)`.

- [ ] **Step 3: Smoke test from Claude.ai**

Call `sb_status`. Expected: returns without error.

- [ ] **Step 4: Test query-aware read**

Save a document with `sb_save_document` using a descriptive path. Call `sb_read` with that path and a specific query. Verify only relevant excerpts are returned.

---

## Companion Prompting Note

Add to Praxis boot context after deploy:

> When saving to second-brain, always use a descriptive path that names the subject.
> Good: `path: "Companions/Drevan/rosie-health-history.md"`
> Avoid: `path: "2026-03-18.md"`
> The file path is the context prefix for every chunk retrieved from that document. Meaningful paths mean better retrieval.
