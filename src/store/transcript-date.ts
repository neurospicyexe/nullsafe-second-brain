// A verbatim export transcript is dated by the conversation, not by the day it was indexed.
//
// 2026-10-12 finding: the 09-06 / 08-15 Claude.ai and ChatGPT export ingests wrote ~48k chunks whose
// `created_at` is the INSERT time (2026-08-15..09-06), while the conversations are 2025-01..2026-07.
// Every consumer that reads `created_at` was misled: the bots' recall labelled a September 2025 thread
// "7 weeks ago" (the exact failure of 09-23, an old thread served as new), the recency term in hybridSearch
// boosted year-old transcripts as if fresh, and path-prefix "recent" reads listed them as recent.
//
// The path is the one place the conversation date is already encoded (ops/ingest-claude-export.py names every
// file `<created-date>-<id8>[.partN].md`), so it is derived from there: no file read, one rule for new writes
// (VectorStore.insert) and for the one-time backfill (VectorStore.initialize).

const TRANSCRIPT_PATH = /^(?:companions\/[^/]+\/claude-ai|archive\/claude-ai|companions\/triad\/chatgpt)\/(\d{4})-(\d{2})-(\d{2})-/;

/** SQL GLOB patterns for the same three directories, for the backfill. */
export const TRANSCRIPT_GLOBS = [
  "companions/*/claude-ai/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*",
  "archive/claude-ai/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*",
  "companions/triad/chatgpt/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*",
];

/** `YYYY-MM-DD 00:00:00` (SQLite datetime shape, UTC) for an export-transcript path, else null. */
export function transcriptCreatedAt(vaultPath: string): string | null {
  const m = TRANSCRIPT_PATH.exec(vaultPath);
  if (!m) return null;
  const [, y, mo, d] = m;
  const t = Date.parse(`${y}-${mo}-${d}T00:00:00Z`);
  // Date.parse rolls 2025-02-31 over; reject anything that did not round-trip.
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  return `${y}-${mo}-${d} 00:00:00`;
}
