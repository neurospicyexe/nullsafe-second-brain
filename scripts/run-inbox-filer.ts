// One-shot INBOX auto-filer runner. The SAFE first thing to run before trusting
// the cron: by default it's a DRY RUN -- classifies everything in "00 - INBOX/"
// and prints what it WOULD do, moving nothing.
//
//   npx tsx scripts/run-inbox-filer.ts              # dry run (no moves, no writes)
//   npx tsx scripts/run-inbox-filer.ts --apply      # actually file (hybrid mode)
//   npx tsx scripts/run-inbox-filer.ts --apply --mode=suggest   # only queue a plan
//
// Modes: hybrid (default) = auto-file confident + queue uncertain; suggest = queue
// everything; auto = file everything. Threshold via --confidence=0.75.

import { loadConfig } from '../src/config.js'
import { loadIngestionConfig } from '../src/ingestion/config.js'
import { createServer } from '../src/server.js'
import { buildVaultAdapter } from '../src/ingestion/vault-materializer.js'
import { callDeepSeek } from '../src/ingestion/deepseek-client.js'
import { Indexer } from '../src/indexer.js'
import {
  runInboxFiler, buildClassifyPrompt, parseDecision, type FilerMode,
} from '../src/ingestion/inbox-filer.js'

async function main() {
  const apply = process.argv.includes('--apply')
  const modeArg = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] as FilerMode | undefined
  const confArg = process.argv.find(a => a.startsWith('--confidence='))?.split('=')[1]
  const mode: FilerMode = modeArg ?? 'hybrid'
  const confidenceThreshold = confArg ? parseFloat(confArg) : 0.75

  const config = loadIngestionConfig()
  const appConfig = loadConfig()
  const { store, embedder } = createServer(appConfig)
  const vault = buildVaultAdapter(appConfig)
  const indexer = new Indexer(vault, embedder, store)

  console.log(`[inbox-filer] ${apply ? 'APPLY' : 'DRY RUN'} mode=${mode} threshold=${confidenceThreshold}`)
  const stats = await runInboxFiler(
    {
      vault,
      classify: async (note) => parseDecision(
        await callDeepSeek(config.deepseekApiKey, config.deepseekModel, buildClassifyPrompt(note)),
      ),
      onMoved: async (from, to) => { store.deleteByPath(from); await indexer.reindex(to) },
    },
    { mode, dryRun: !apply, confidenceThreshold },
  )
  console.log('[inbox-filer] result:', JSON.stringify(stats))
  if (!apply) console.log('[inbox-filer] dry run -- nothing moved. Re-run with --apply to file for real.')
  process.exit(0)
}

main().catch(err => { console.error('[inbox-filer] fatal:', err); process.exit(1) })
