import { loadConfig } from '../src/config.js'
import { loadIngestionConfig } from '../src/ingestion/config.js'
import { createServer } from '../src/server.js'
import { processCorpus } from '../src/ingestion/corpus.js'

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--force')
  const force = process.argv.includes('--force')
  const intakeDir = args[0] ?? process.env.INTAKE_DIR
  if (!intakeDir) {
    console.error('Usage: npx tsx scripts/run-corpus.ts <intake-dir> [--force]')
    process.exit(1)
  }

  if (force) console.log('[run-corpus] --force: existing chunks will be deleted and re-indexed')

  const config = loadIngestionConfig()
  const appConfig = loadConfig()
  const { store, embedder } = createServer(appConfig)

  await processCorpus({ intakeDir, sourceType: 'historical_corpus', force }, config, store, embedder)

  process.exit(0)
}

main().catch(err => {
  console.error('[run-corpus] fatal:', err)
  process.exit(1)
})
