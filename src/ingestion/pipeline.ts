import type { IngestionConfig } from './types.js'
import type { IngestRecord } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import { ALL_PULLERS } from './puller.js'
import { wrapChunk } from './deepseek-wrapper.js'
import { loadHwm, saveHwm, getHwm, setHwm } from './hwm.js'

// Sources that write machine-generated entries back to companion_journal.
// Embedding these pollutes semantic search with diagnostic/synthetic text.
const MACHINE_JOURNAL_SOURCES = new Set(['pattern_worker', 'evaluator', 'synthesis-gap-detector'])

function isMachineGenerated(record: IngestRecord): boolean {
  if (record.source_type !== 'companion_journal') return false
  try {
    const parsed = JSON.parse(record.content) as Record<string, unknown>
    return typeof parsed.source === 'string' && MACHINE_JOURNAL_SOURCES.has(parsed.source)
  } catch { return false }
}

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

        // Skip machine-generated journal entries -- embedding them pollutes
        // semantic search and creates feedback loops on re-ingest.
        if (isMachineGenerated(record)) {
          console.log(`[ingestion] skip machine-generated ${chunkId}`)
          hwm = setHwm(hwm, source, record.created_at)
          saveHwm(this.config.hwmPath, hwm)
          continue
        }

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
