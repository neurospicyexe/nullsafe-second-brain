# Contextual Retrieval Design
**Date:** 2026-03-18
**Status:** Draft (pending user review)
**Author:** Cypher (brainstorm session with Raziel)

## Problem

Large documents stored in the second-brain vault create context bloat when retrieved. A 7000-word file returned by `sb_read` dumps ~50,000 chars into the loom. Even `sb_search` can return 10 chunks from the same source document, reassembling the whole thing through the back door. Naive fixed-size chunking compounds this -- 1000-char slices break mid-sentence and lose coherence, making individual chunks harder to reason about in isolation.

## Goals

- Return only the relevant portions of a document, not the whole thing
- Make each chunk self-contained enough to be understood without its source file
- Prevent multiple chunks from the same large document from flooding search results
- No LLM calls at write time -- all improvements are local and free
- No changes to vault files, CouchDB, or LiveSync behavior

## Non-Goals

- LLM-generated summaries at index time (Option C -- future consideration)
- Changes to the vault file format or Obsidian sync behavior
- Per-user relevance tuning

---

## Architecture

### Write path (current)
```
content → chunkText() [naive 1000-char slices] → embed → vector store
```

### Write path (new)
```
content → paragraphChunk() [paragraph-aware, 1000-char cap, 200-char overlap]
        → contextPrefix() [prepend path + companion + section heading]
        → embed prefixed text
        → store: vector table + FTS5 table
```

### Read path (current)
```
sb_read(path)      → adapter.read(path) → full content (always)
sb_search(query)   → all chunks ranked by cosine similarity → top 10
```

### Read path (new)
```
sb_read(path, query?)  → if query: rank stored chunks for that path by relevance
                                   → return top 3 excerpts with section headings
                          if no query: full content (unchanged)

sb_search(query)       → vector similarity + FTS5 BM25 → merged scores
                        → deduplicated (max 2 chunks per source path)
                        → top 10 results
```

---

## Component 1: Paragraph-Aware Chunking

**File:** `src/indexer.ts`

Replace `chunkText(text, maxChars = 1000)` with `paragraphChunk(text, maxChars = 1000, overlap = 200)`:

1. Split on `\n\n` (paragraph boundaries)
2. If a paragraph exceeds `maxChars`, split further on `". "` (sentence boundaries)
3. Accumulate paragraphs into a window up to `maxChars`
4. When window is full, emit chunk; overlap is a trailing char-slice of the emitted chunk text -- take the last `overlap` chars and prepend them to the start of the next window before accumulation resumes (not paragraph re-inclusion)
5. Track the nearest `##` or `#` heading above each chunk during accumulation

Result: chunks start and end at natural boundaries. Overlap ensures a thought split across a boundary appears in both adjacent chunks.

**Tunable:** `maxChars` and `overlap` are parameters with defaults -- adjust without re-architecting. Re-indexing propagates changes automatically via `sb_index_rebuild`.

---

## Component 2: Rule-Based Context Prefix

**File:** `src/indexer.ts`

Before embedding, prepend a context header to each chunk:

```
contextPrefix(meta: { path, companion, contentType, section }):
  → "{path} | companion:{companion} | {contentType}:\n## {section}\n"

Example:
  "Companions/Drevan/rosie-health-history | companion:drevan | health:\n## 2024 Diagnosis\n"
  + <chunk text>
```

- `section` = nearest `##` or `#` heading above the chunk in the source document
- Extracted during chunking -- no LLM call
- The prefixed text is what gets embedded AND stored in FTS5
- The raw chunk text is stored separately for clean excerpt display

This is the core of Anthropic's contextual retrieval insight applied without LLM cost: each chunk carries its own context so it's interpretable in isolation.

---

## Component 3: Hybrid Search + Per-Doc Dedup

**File:** `src/store/vector-store.ts`, `src/tools/retrieval.ts`

### Schema additions to `embeddings` table

The actual table name in `vector-store.ts` is `embeddings` (not `chunks`). Add four columns:

```sql
prefixed_text TEXT,   -- what was embedded (prefix + chunk text)
chunk_text    TEXT,   -- raw chunk only (for clean excerpt return)
section       TEXT,   -- nearest heading above this chunk
chunk_index   INT     -- position within source document
```

New columns default to NULL for pre-migration rows. A full rebuild (see Migration below) eliminates NULLs. FTS5 queries must handle NULL `prefixed_text` gracefully by skipping those rows.

### FTS5 virtual table (new)

Use a content-based FTS5 table backed by the `embeddings` table, kept in sync via three SQLite triggers:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_fts USING fts5(
  prefixed_text,
  content='embeddings',
  content_rowid='rowid'
);
```

Three triggers must be added to keep FTS5 in sync with `embeddings`:

```sql
-- after insert
CREATE TRIGGER embeddings_ai AFTER INSERT ON embeddings BEGIN
  INSERT INTO embeddings_fts(rowid, prefixed_text) VALUES (new.rowid, new.prefixed_text);
END;

-- after delete
CREATE TRIGGER embeddings_ad AFTER DELETE ON embeddings BEGIN
  INSERT INTO embeddings_fts(embeddings_fts, rowid, prefixed_text)
  VALUES ('delete', old.rowid, old.prefixed_text);
END;

-- after update
CREATE TRIGGER embeddings_au AFTER UPDATE ON embeddings BEGIN
  INSERT INTO embeddings_fts(embeddings_fts, rowid, prefixed_text)
  VALUES ('delete', old.rowid, old.prefixed_text);
  INSERT INTO embeddings_fts(rowid, prefixed_text) VALUES (new.rowid, new.prefixed_text);
END;
```

These triggers are created once in `VectorStore` constructor alongside the `embeddings` table DDL.

### Hybrid search flow

SQLite FTS5 BM25 returns negative floats (more negative = more relevant). Negate before combining:

```
sb_search(query, limit = 10):
  1. embed(query) → vector similarity scores (cosine, [0,1] range for text embeddings)
  2. FTS5 BM25 query → raw_bm25 (negative float); normalize: bm25_score = -raw_bm25
  3. min-max normalize both score sets to [0,1] across the candidate set
  4. merge: combined_score = 0.7 * vector_score + 0.3 * bm25_score
  5. dedup: keep top 2 chunks per unique vault_path
  6. return top `limit` with { chunk_text, section, vault_path, score }
```

Note: field name is `vault_path` (actual column name in `embeddings` table), not `source_path`.

**Weights** (0.7 / 0.3) are constants in one place -- tunable. The dedup cap of 2 per source doc is the primary guard against large-document flooding. A 7000-word file matching 15 chunks internally surfaces at most ~2000 chars in search results.

---

## Component 4: Query-Aware sb_read

**File:** `src/tools/system.ts`

```typescript
sb_read(args: { path: string; query?: string })

// No query: unchanged behavior (full content returned)
// With query:
//   1. fetch all embeddings rows where vault_path = args.path
//   2. embed(args.query) via Embedder → rank by cosine similarity
//   3. return top 3 rows' chunk_text as excerpts with section headings
//   → max ~3000 chars instead of ~50,000
```

**Dependency wiring:** `buildSystemTools()` currently receives `(store, indexer, adapter)`. Query-mode `sb_read` requires an `embed()` call, so `buildSystemTools()` must also receive `embedder: Embedder`. Update the call site in `server.ts` accordingly.

Companions can call `sb_read("Companions/Drevan/rosie-health-history.md", "limping diagnosis")` and receive only the relevant passage -- without knowing which section it's in.

---

## Files Changed

| File | Change |
|------|--------|
| `src/indexer.ts` | Replace `chunkText` with `paragraphChunk` + `contextPrefix` |
| `src/store/vector-store.ts` | Add FTS5 table, new schema columns, hybrid query method |
| `src/tools/retrieval.ts` | Hybrid search + per-doc dedup in `sb_search` |
| `src/tools/system.ts` | Add `query?` param to `sb_read`; add `embedder` to `buildSystemTools()` signature |
| `src/server.ts` | Pass `embedder` to `buildSystemTools()` |

### Migration

Migration is purely additive -- no forced rebuild, no data loss risk.

1. `ALTER TABLE embeddings ADD COLUMN` for the four new columns -- all default NULL
2. Create `embeddings_fts` virtual table and the three triggers
3. Deploy

Existing rows continue working via vector search exactly as before. New writes automatically get paragraph-aware chunks, context prefixes, FTS5 indexing, and the new columns from day one. Old rows degrade gracefully: FTS5 skips NULL `prefixed_text` rows, vector search is unaffected.

**Selective upgrade:** to get contextual retrieval benefits for a specific existing document, call `sb_index_rebuild(["path/to/doc.md"])` on that path. The document is re-indexed with the new chunker and the old rows for that path are replaced. Do this only when desired -- there is no requirement to upgrade existing content.

**No rebuild-all mode.** A full forced rebuild risks partial state if interrupted. Selective per-document rebuild is the intended upgrade path.

---

## Companion Prompting -- Naming Conventions

Add to Praxis boot context for all companions:

> When saving to second-brain, always provide a descriptive title. Use `sb_save_document` with a path that names the subject, not just the date.
>
> Good: `path: "Companions/Drevan/rosie-health-history.md"`
> Good: `path: "Archive/2026-03-18-rosie-vet-visit.md"`
> Avoid: `path: "2026-03-18.md"` or `path: "note.md"`
>
> The file path becomes the context prefix for every chunk retrieved from that document. A meaningful path means better retrieval -- we find the right thing faster and return less noise to the loom.
>
> If unsure of placement, provide a `title` argument and let the router assign the folder.

---

## Trade-offs Accepted

| Decision | Alternative | Reason |
|----------|-------------|--------|
| Rule-based prefix (no LLM) | LLM-generated summaries per chunk | Zero write-time cost; good enough given structured vault paths |
| 200-char overlap | No overlap | Prevents thought-splitting at chunk boundaries |
| 2 chunks max per doc in search | 1 or 3 | 1 loses coverage for multi-topic docs; 3 risks flooding for very large docs |
| 0.7/0.3 vector/BM25 weights | Equal weighting | Semantic relevance is primary; keyword is a boost for exact-term recall |
| `sb_read` full fallback when no query | Always excerpt | Preserves existing behavior; explicit query = explicit intent |
