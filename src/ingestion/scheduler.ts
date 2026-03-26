import cron from 'node-cron'
import type { IngestionConfig } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import { createPipeline } from './pipeline.js'

export function startIngestionScheduler(
  config: IngestionConfig,
  store: VectorStore,
  embedder: OpenAIEmbedder
): void {
  const pipeline = createPipeline(config, store, embedder)

  console.log(`[ingestion] scheduler starting, cron: ${config.cronSchedule}`)

  cron.schedule(config.cronSchedule, async () => {
    console.log('[ingestion] cron tick: running pipeline')
    try {
      await pipeline.run()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] pipeline error: ${msg}`)
    }
  })
}
