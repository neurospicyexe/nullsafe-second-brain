export type SourceType =
  | 'synthesis_summary'
  | 'relational_delta'
  | 'feeling'
  | 'companion_journal'
  | 'inter_companion_note'
  | 'handoff'
  | 'historical_corpus'
  | 'claude_export'
  | 'wound'
  | 'companion_dream'
  | 'open_loop'
  | 'relational_state'
  | 'tension'
  | 'growth_journal'
  | 'companion_conclusion'
  | 'somatic_snapshot'
  | 'drift_log'
  | 'live_thread'
  | 'basin_history'

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
  evaluatorCronSchedule: string      // default: '0 */6 * * *' (every 6h)
  sitPromptCronSchedule: string      // default: '0 */12 * * *' (twice daily)
  patternSynthCronSchedule: string   // default: '0 2 * * 0' (Sunday 2am)
  personaFeederCronSchedule: string  // default: '30 */6 * * *' (30min before evaluator)
  corpusIntakeDir?: string           // optional: folder of .md files for recurring corpus backfill (recursive)
  corpusCronSchedule?: string        // default: '0 */6 * * *' (every 6h); only fires if corpusIntakeDir is set
  vaultMaterializerCronSchedule?: string  // default: '*/30 * * * *' (every 30m); pulls unmaterialized growth rows and writes .md files
  thoughtformDetectorCronSchedule?: string // default: '0 3 * * *' (daily 3am UTC); POSTs /mind/growth/thoughtforms/detect
  // INBOX auto-filer (2026-06-13). OFF by default -- Raziel flips INBOX_FILER=true
  // after a dry-run. hybrid: auto-file >= confidence, queue the rest for one-tap approval.
  inboxFilerEnabled?: boolean              // INBOX_FILER (default false)
  inboxFilerMode?: 'hybrid' | 'auto' | 'suggest'  // INBOX_FILER_MODE (default 'hybrid')
  inboxFilerConfidence?: number            // INBOX_FILER_CONFIDENCE (default 0.75)
  inboxFilerCronSchedule?: string          // INBOX_FILER_CRON (default '15 * * * *', hourly)
}
