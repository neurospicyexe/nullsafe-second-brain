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

export function isMachineGenerated(record: IngestRecord): boolean {
  if (record.source_type !== 'companion_journal') return false
  try {
    const parsed = JSON.parse(record.content) as Record<string, unknown>
    return typeof parsed.source === 'string' && MACHINE_JOURNAL_SOURCES.has(parsed.source)
  } catch { return false }
}

// Emotional valence at encoding time, for SOMA-weighted retrieval. The raw row is
// JSON inside record.content; different sources carry the emotion under different
// keys. First present-and-non-empty wins. Null = no boost ever (additive only).
const VALENCE_KEYS = ['emotion', 'valence', 'emotional_register', 'current_mood', 'emotional_frequency'] as const

export function extractValence(record: IngestRecord): string | null {
  try {
    const parsed = JSON.parse(record.content) as Record<string, unknown>
    for (const key of VALENCE_KEYS) {
      const v = parsed[key]
      if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase().slice(0, 60)
    }
  } catch { /* non-JSON content = no valence */ }
  return null
}

// Halseth source rows carry tags as JSON-array-encoded strings under different column
// names depending on table (companion_journal: tags + topic_tags; other tables may add
// their own later). record.content is JSON.stringify(rawRow), so the tags already ride
// along in every pulled record -- 2026-07-08 finding was that nothing on this side ever
// unpacked them into the vector store's own tags column. This closes that gap.
const TAG_KEYS = ['tags', 'topic_tags'] as const

export function extractTags(record: IngestRecord): string[] {
  const combined = new Set<string>()
  try {
    const parsed = JSON.parse(record.content) as Record<string, unknown>
    for (const key of TAG_KEYS) {
      const raw = parsed[key]
      if (typeof raw !== 'string' || !raw.trim()) continue
      try {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          for (const t of arr) if (typeof t === 'string' && t.trim()) combined.add(t.trim())
        }
      } catch { /* not JSON -- skip this key */ }
    }
  } catch { /* non-JSON content = no tags */ }
  return [...combined]
}

export class IngestionPipeline {
  constructor(
    private config: IngestionConfig,
    private store: VectorStore,
    private embedder: OpenAIEmbedder,
  ) {}

  async run(): Promise<void> {
    let hwm = loadHwm(this.config.hwmPath)

    for (const { source, pull, isUpdate } of ALL_PULLERS) {
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

        // Dedup: skip if already indexed (unless this is an update sweep -- delete and re-index)
        if (this.store.existsByPath(vaultPath)) {
          if (!isUpdate) {
            console.log(`[ingestion] skip duplicate ${chunkId}`)
            continue
          }
          this.store.deleteByPath(vaultPath)
          console.log(`[ingestion] update ${chunkId} -- replaced stale entry`)
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

          // Index into vector store. prefixed_text MUST be set: the FTS5 lexical index is
          // built only on prefixed_text, so omitting it makes the chunk invisible to keyword
          // search (findable only by the cosine fallback). wrappedContent is the searchable
          // narrative, so it serves as both chunk_text and prefixed_text here.
          this.store.insert({
            vault_path: vaultPath,
            companion: record.companion_id ?? null,
            content_type: record.source_type,
            chunk_text: wrappedContent,
            prefixed_text: wrappedContent,
            embedding,
            tags: extractTags(record),
            valence: extractValence(record),
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
