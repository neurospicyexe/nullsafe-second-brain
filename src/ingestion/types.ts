export type SourceType =
  | 'synthesis_summary'
  | 'relational_delta'
  | 'feeling'
  | 'companion_journal'
  | 'inter_companion_note'
  | 'handoff'
  | 'historical_corpus'
  | 'claude_export'

export interface IngestRecord {
  id: number
  source_type: SourceType
  content: string        // serialized JSON of the raw record
  created_at: string     // ISO timestamp
  companion_id?: string  // cypher | drevan | gaia | null (cross-companion)
  thread_key?: string
}

export interface HwmMap {
  [source: string]: string // source_type -> ISO timestamp of last successful index
}

export interface IngestionConfig {
  halsethUrl: string
  halsethSecret: string
  deepseekApiKey: string
  deepseekModel: string        // default: 'deepseek-chat'
  cronSchedule: string         // default: '*/20 * * * *'
  concurrencyLimit: number     // for corpus backfill, default: 3
  concurrencyDelayMs: number   // default: 500
  embeddingBatchSize: number   // default: 20
  hwmPath: string              // path to data/hwm.json
}
