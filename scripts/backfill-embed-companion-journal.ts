// scripts/backfill-embed-companion-journal.ts
//
// One-time retroactive re-embed (2026-07-08): companion_journal rows indexed before the
// tag classifier shipped carry tags: [] in the vector store, even after the Halseth-side
// D1 backfill (halseth/scripts/backfill-journal-tags.ts) populated the real columns --
// the ingestion pipeline's existsByPath dedup means it never re-pulls an already-indexed
// row. This deletes and re-embeds each companion_journal entry so its vector-store tags
// column reflects the backfilled D1 data.
//
// Also works around a real limitation found while building this: GET /companion-journal
// ignores the `since` query param entirely and always returns only the newest 100 rows
// (see halseth/src/handlers/companion_journal.ts) -- the normal incremental puller can
// never reach the full history. This script reads a full D1 export instead (see Usage).
//
// Usage:
//   npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --json \
//     --command "SELECT id, agent, note_text, tags, topic_tags, session_id, source, created_at FROM companion_journal ORDER BY created_at ASC" \
//     > /tmp/all_journal_rows.json
//   npx tsx scripts/backfill-embed-companion-journal.ts /tmp/all_journal_rows.json [--limit N] [--dry-run]

import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { loadIngestionConfig } from "../src/ingestion/config.js";
import { createServer } from "../src/server.js";
import { wrapChunk } from "../src/ingestion/deepseek-wrapper.js";
import { withConcurrencyLimit } from "../src/ingestion/corpus.js";
import { extractTags, extractValence, isMachineGenerated } from "../src/ingestion/pipeline.js";
import type { IngestRecord } from "../src/ingestion/types.js";

interface JournalRow {
  id: string;
  agent: string;
  note_text: string;
  tags: string | null;
  topic_tags: string | null;
  session_id: string | null;
  source: string | null;
  created_at: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;

  if (!inputPath) {
    console.error("Usage: tsx backfill-embed-companion-journal.ts <rows.json> [--limit N] [--dry-run]");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(inputPath, "utf-8"));
  let rows: JournalRow[] = raw[0]?.results ?? [];
  if (limit) rows = rows.slice(0, limit);

  console.log(`[backfill-embed] ${rows.length} rows loaded${dryRun ? " (DRY RUN)" : ""}`);

  const appConfig = loadConfig();
  const ingestionConfig = loadIngestionConfig();
  const { store, embedder } = createServer(appConfig);

  let indexed = 0, skippedMachine = 0, skippedEmpty = 0, failed = 0;

  await withConcurrencyLimit(rows, ingestionConfig.concurrencyLimit, ingestionConfig.concurrencyDelayMs, async (row) => {
    if (!row.note_text || !row.note_text.trim()) { skippedEmpty++; return; }

    const record: IngestRecord = {
      id: row.id as unknown as number, // IngestRecord.id is typed number but only ever used as an opaque key here
      source_type: "companion_journal",
      content: JSON.stringify(row),
      created_at: row.created_at,
      companion_id: row.agent,
    };

    if (isMachineGenerated(record)) { skippedMachine++; return; }

    const vaultPath = `rag/companion_journal/${row.id}`;

    if (dryRun) {
      console.log(`[dry-run] would re-embed ${vaultPath} tags=${row.tags} topic_tags=${row.topic_tags}`);
      indexed++;
      return;
    }

    try {
      if (store.existsByPath(vaultPath)) store.deleteByPath(vaultPath);

      const wrapped = await wrapChunk(record, ingestionConfig);
      const embedding = await embedder.embed(wrapped);
      if (!embedding || embedding.length === 0) throw new Error("empty embedding");

      store.insert({
        vault_path: vaultPath,
        companion: record.companion_id ?? null,
        content_type: "companion_journal",
        chunk_text: wrapped,
        prefixed_text: wrapped,
        embedding,
        tags: extractTags(record),
        valence: extractValence(record),
      });
      indexed++;
      if (indexed % 50 === 0) console.log(`[backfill-embed] progress: ${indexed}/${rows.length}`);
    } catch (err) {
      failed++;
      console.error(`[backfill-embed] failed ${vaultPath}:`, err instanceof Error ? err.message : err);
    }
  });

  console.log(`[backfill-embed] done. indexed=${indexed} skipped_machine=${skippedMachine} skipped_empty=${skippedEmpty} failed=${failed}`);
}

main().catch(err => {
  console.error("[backfill-embed] fatal:", err);
  process.exit(1);
});
