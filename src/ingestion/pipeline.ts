import type { IngestionConfig } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import { ALL_PULLERS } from './puller.js'
import { wrapChunk } from './deepseek-wrapper.js'
import { loadHwm, saveHwm, getHwm, setHwm } from './hwm.js'

export class IngestionPipeline {
  constructor(
    private config: IngestionConfig,
    private store: VectorStore,
    private embedder: OpenAIEmbedder,
  ) {}

  async run(): Promise<void> {
    let hwm = loadHwm(this.config.hwmPath)

    for (const { source, pull } of ALL_PULLERS) {
      const since = getHwm(hwm, source)
      console.log(`[ingestion] pulling ${source} since ${since ?? 'beginning'}`)

      const { records, error } = await pull(this.config, since)

      if (error) {
        console.error(`[ingestion] pull failed for ${source}: ${error}`)
        continue
      }

      console.log(`[ingestion] ${source}: ${records.length} records fetched`)

      for (const record of records) {
        const chunkId = `${record.source_type}:${record.id}`
        const vaultPath = `rag/${record.source_type}/${record.id}`

        // Dedup: skip if already indexed
        if (this.store.existsByPath(vaultPath)) {
          console.log(`[ingestion] skip duplicate ${chunkId}`)
          continue
        }

        try {
          // Wrap with contextual preamble
          const wrappedContent = await wrapChunk(record, this.config)

          // Embed
          const embedding = await this.embedder.embed(wrappedContent)

          if (!embedding || embedding.length === 0) {
            console.error(`[ingestion] empty embedding for ${chunkId}`)
            continue
          }

          // Index into vector store
          this.store.insert({
            vault_path: vaultPath,
            companion: record.companion_id ?? null,
            content_type: record.source_type,
            chunk_text: wrappedContent,
            embedding,
            tags: [],
          })

          // Advance HWM per-record (only after successful index)
          hwm = setHwm(hwm, source, record.created_at)
          saveHwm(this.config.hwmPath, hwm)

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[ingestion] failed to index ${chunkId}: ${msg}`)
          // Do NOT advance HWM on failure -- will retry next cycle
        }
      }
    }

    console.log('[ingestion] cycle complete')
  }
}

export function createPipeline(
  config: IngestionConfig,
  store: VectorStore,
  embedder: OpenAIEmbedder,
): IngestionPipeline {
  return new IngestionPipeline(config, store, embedder)
}
