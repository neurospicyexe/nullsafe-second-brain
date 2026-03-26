import { loadConfig } from '../src/config.js'
import { loadIngestionConfig } from '../src/ingestion/config.js'
import { createServer } from '../src/server.js'
import { processCorpus } from '../src/ingestion/corpus.js'

async function main() {
  const intakeDir = process.argv[2] ?? process.env.INTAKE_DIR
  if (!intakeDir) {
    console.error('Usage: npx tsx scripts/run-corpus.ts <intake-dir>')
    process.exit(1)
  }

  const config = loadIngestionConfig()
  const appConfig = loadConfig()
  const { store, embedder } = createServer(appConfig)

  await processCorpus({ intakeDir, sourceType: 'historical_corpus' }, config, store, embedder)

  process.exit(0)
}

main().catch(err => {
  console.error('[run-corpus] fatal:', err)
  process.exit(1)
})
