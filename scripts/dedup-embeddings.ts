// One-shot maintenance: collapse duplicate embedding rows that share the same
// (vault_path, chunk_index) -- genuine re-embeds of one source record, NOT multi-chunk files
// (those have distinct chunk_index per chunk and are left untouched). Keeps the newest row per
// group. Dry-run by default; pass --apply to actually delete.
//
//   npx tsx scripts/dedup-embeddings.ts          # report only
//   npx tsx scripts/dedup-embeddings.ts --apply  # delete dupes
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

async function main() {
  const apply = process.argv.includes('--apply')
  const { store } = createServer(loadConfig())
  const count = store.dedupeByPathAndIndex(!apply)
  if (apply) {
    console.log(`[dedup] removed ${count} duplicate rows (kept newest per vault_path+chunk_index)`)
  } else {
    console.log(`[dedup] DRY RUN: ${count} duplicate rows would be removed. Re-run with --apply to delete.`)
  }
  process.exit(0)
}
main().catch(e => { console.error('[dedup] fatal:', e); process.exit(1) })
