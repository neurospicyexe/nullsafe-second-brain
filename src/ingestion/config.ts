import path from 'path'
import { fileURLToPath } from 'url'
import type { IngestionConfig } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function loadIngestionConfig(): IngestionConfig {
  const halsethUrl = process.env.HALSETH_URL
  const halsethSecret = process.env.HALSETH_SECRET
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY

  if (!halsethUrl) throw new Error('HALSETH_URL env var is required for ingestion')
  if (!halsethSecret) throw new Error('HALSETH_SECRET env var is required for ingestion')
  if (!deepseekApiKey) throw new Error('DEEPSEEK_API_KEY env var is required for ingestion')

  // Resolve hwm path relative to this file: src/ingestion/ -> src/ -> project root -> data/hwm.json
  const hwmPath = path.resolve(__dirname, '../../data/hwm.json')

  return {
    halsethUrl,
    halsethSecret,
    deepseekApiKey,
    deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    cronSchedule: process.env.INGESTION_CRON ?? '*/20 * * * *',
    concurrencyLimit: parseInt(process.env.INGESTION_CONCURRENCY ?? '3', 10),
    concurrencyDelayMs: parseInt(process.env.INGESTION_DELAY_MS ?? '500', 10),
    embeddingBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE ?? '20', 10),
    hwmPath,
    evaluatorCronSchedule: process.env.EVALUATOR_CRON ?? '0 */6 * * *',
    sitPromptCronSchedule: process.env.SIT_PROMPT_CRON ?? '0 */12 * * *',
    patternSynthCronSchedule: process.env.PATTERN_SYNTH_CRON ?? '0 2 * * 0',
  }
}
