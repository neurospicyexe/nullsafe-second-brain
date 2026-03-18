# Contextual Retrieval Design
**Date:** 2026-03-18
**Status:** Approved
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
4. When window is full, emit chunk; backtrack `overlap` chars into next window
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

### Schema additions to `chunks` table

```sql
prefixed_text TEXT,   -- what was embedded (prefix + chunk text)
chunk_text    TEXT,   -- raw chunk only (for clean excerpt return)
section       TEXT,   -- nearest heading above this chunk
chunk_index   INT     -- position within source document
```

### FTS5 virtual table (new)

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  prefixed_text,
  content='chunks',
  content_rowid='id'
);
```

### Hybrid search flow

```
sb_search(query, limit = 10):
  1. embed(query) → vector similarity scores (cosine, existing)
  2. FTS5 BM25 query on prefixed_text → keyword scores
  3. merge: combined_score = 0.7 * vector_score + 0.3 * bm25_score
  4. dedup: keep top 2 chunks per unique source_path
  5. return top `limit` with { chunk_text, section, source_path, score }
```

**Weights** (0.7 / 0.3) are constants in one place -- tunable. The dedup cap of 2 per source doc is the primary guard against large-document flooding. A 7000-word file matching 15 chunks internally surfaces at most ~2000 chars in search results.

---

## Component 4: Query-Aware sb_read

**File:** `src/tools/system.ts`

```typescript
sb_read(args: { path: string; query?: string })

// No query: unchanged behavior (full content returned)
// With query:
//   1. fetch all chunks where source_path = args.path
//   2. embed(args.query) → rank by cosine similarity
//   3. return top 3 chunks as excerpts with section headings
//   → max ~3000 chars instead of ~50,000
```

Companions can call `sb_read("Companions/Drevan/rosie-health-history.md", "limping diagnosis")` and receive only the relevant passage -- without knowing which section it's in.

---

## Files Changed

| File | Change |
|------|--------|
| `src/indexer.ts` | Replace `chunkText` with `paragraphChunk` + `contextPrefix` |
| `src/store/vector-store.ts` | Add FTS5 table, new schema columns, hybrid query method |
| `src/tools/retrieval.ts` | Hybrid search + per-doc dedup in `sb_search` |
| `src/tools/system.ts` | Add `query?` param to `sb_read` |

Migration: run `sb_index_rebuild` on existing documents after deploy. Existing chunks are replaced with new prefixed, paragraph-aware chunks.

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
