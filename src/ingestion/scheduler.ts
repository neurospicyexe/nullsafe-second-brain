import cron from 'node-cron'
import type { IngestionConfig } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import { createPipeline } from './pipeline.js'
import { runGapDetector } from './gap-detector.js'
import { runDriftEvaluation } from './evaluator.js'
import { runSitPrompts } from './sit-prompts.js'
import { runPatternSynthesis } from './pattern-synthesizer.js'

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

    // Gap detector: fill companion notes for relational sessions that were missed.
    // Runs after pipeline regardless of pipeline success/failure.
    try {
      await runGapDetector(config)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] gap-detector error: ${msg}`)
    }
  })

  // Drift evaluator: runs independently every 6h (configurable via EVALUATOR_CRON).
  // Compares persona_blocks to basin attractors, writes drift history + pressure flags.
  console.log(`[ingestion] evaluator cron: ${config.evaluatorCronSchedule}`)
  cron.schedule(config.evaluatorCronSchedule, async () => {
    console.log('[ingestion] evaluator tick: running drift evaluation')
    try {
      await runDriftEvaluation(config, embedder)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] evaluator error: ${msg}`)
    }
  })

  // Sit & Resolve prompts: runs every 12h (configurable via SIT_PROMPT_CRON).
  // Finds sitting notes older than each companion's sit_resolve_days threshold,
  // writes a sit_prompt companion_note so the companion sees it at next boot.
  console.log(`[ingestion] sit-prompts cron: ${config.sitPromptCronSchedule}`)
  cron.schedule(config.sitPromptCronSchedule, async () => {
    console.log('[ingestion] sit-prompts tick: checking stale sitting notes')
    try {
      await runSitPrompts(config)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] sit-prompts error: ${msg}`)
    }
  })

  // Pattern synthesis: runs weekly (default: Sunday 2am, configurable via PATTERN_SYNTH_CRON).
  // Pulls last 30d of companion writes, identifies recurring patterns via DeepSeek,
  // writes synthesis back to companion_journal tagged [pattern_synthesis].
  console.log(`[ingestion] pattern-synth cron: ${config.patternSynthCronSchedule}`)
  cron.schedule(config.patternSynthCronSchedule, async () => {
    console.log('[ingestion] pattern-synth tick: running pattern synthesis')
    try {
      await runPatternSynthesis(config)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] pattern-synth error: ${msg}`)
    }
  })
}
