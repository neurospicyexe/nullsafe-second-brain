import cron from 'node-cron'
import type { IngestionConfig } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import { createPipeline } from './pipeline.js'
import { runGapDetector } from './gap-detector.js'
import { runDriftEvaluation } from './evaluator.js'
import { runSitPrompts } from './sit-prompts.js'
import { runPatternSynthesis } from './pattern-synthesizer.js'
import { runPersonaFeeder } from './persona-feeder.js'
import { cronHealth } from './cron-health.js'

export function startIngestionScheduler(
  config: IngestionConfig,
  store: VectorStore,
  embedder: OpenAIEmbedder
): void {
  const pipeline = createPipeline(config, store, embedder)

  // Register all jobs with expected intervals before any ticks fire.
  cronHealth.register('ingestion_pipeline', 20 * 60 * 1000)
  cronHealth.register('drift_evaluator', 6 * 60 * 60 * 1000)
  cronHealth.register('sit_prompts', 12 * 60 * 60 * 1000)
  cronHealth.register('pattern_synth', 7 * 24 * 60 * 60 * 1000)
  cronHealth.register('persona_feeder', 6 * 60 * 60 * 1000)

  console.log(`[ingestion] scheduler starting, cron: ${config.cronSchedule}`)

  // Per-job running flags. node-cron callbacks are single-process so a boolean is sufficient.
  let pipelineRunning = false
  let evaluatorRunning = false
  let sitPromptsRunning = false
  let personaFeederRunning = false
  let patternSynthRunning = false

  cron.schedule(config.cronSchedule, async () => {
    if (pipelineRunning) {
      console.warn('[ingestion] pipeline still running from previous tick, skipping')
      return
    }
    pipelineRunning = true
    console.log('[ingestion] cron tick: running pipeline')
    cronHealth.start('ingestion_pipeline')
    try {
      await pipeline.run()

      // Gap detector runs after pipeline regardless of pipeline success.
      try {
        await runGapDetector(config)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ingestion] gap-detector error: ${msg}`)
      }

      cronHealth.complete('ingestion_pipeline')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] pipeline error: ${msg}`)
      cronHealth.fail('ingestion_pipeline', msg)
    } finally {
      pipelineRunning = false
    }
  })

  // Drift evaluator: runs independently every 6h (configurable via EVALUATOR_CRON).
  // Compares persona_blocks to basin attractors, writes drift history + pressure flags.
  console.log(`[ingestion] evaluator cron: ${config.evaluatorCronSchedule}`)
  cron.schedule(config.evaluatorCronSchedule, async () => {
    if (evaluatorRunning) {
      console.warn('[ingestion] evaluator still running from previous tick, skipping')
      return
    }
    evaluatorRunning = true
    console.log('[ingestion] evaluator tick: running drift evaluation')
    cronHealth.start('drift_evaluator')
    try {
      await runDriftEvaluation(config, embedder)
      cronHealth.complete('drift_evaluator')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] evaluator error: ${msg}`)
      cronHealth.fail('drift_evaluator', msg)
    } finally {
      evaluatorRunning = false
    }
  })

  // Sit & Resolve prompts: runs every 12h (configurable via SIT_PROMPT_CRON).
  // Finds sitting notes older than each companion's sit_resolve_days threshold,
  // writes a sit_prompt companion_note so the companion sees it at next boot.
  console.log(`[ingestion] sit-prompts cron: ${config.sitPromptCronSchedule}`)
  cron.schedule(config.sitPromptCronSchedule, async () => {
    if (sitPromptsRunning) {
      console.warn('[ingestion] sit-prompts still running from previous tick, skipping')
      return
    }
    sitPromptsRunning = true
    console.log('[ingestion] sit-prompts tick: checking stale sitting notes')
    cronHealth.start('sit_prompts')
    try {
      await runSitPrompts(config)
      cronHealth.complete('sit_prompts')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] sit-prompts error: ${msg}`)
      cronHealth.fail('sit_prompts', msg)
    } finally {
      sitPromptsRunning = false
    }
  })

  // Persona feeder: runs every 6h, 30min before drift evaluator (configurable via PERSONA_FEEDER_CRON).
  // Extracts organic voice blocks from companion journal, posts to persona_blocks table.
  console.log(`[ingestion] persona-feeder cron: ${config.personaFeederCronSchedule}`)
  cron.schedule(config.personaFeederCronSchedule, async () => {
    if (personaFeederRunning) {
      console.warn('[ingestion] persona-feeder still running from previous tick, skipping')
      return
    }
    personaFeederRunning = true
    console.log('[ingestion] persona-feeder tick: extracting voice blocks')
    cronHealth.start('persona_feeder')
    try {
      await runPersonaFeeder(config)
      cronHealth.complete('persona_feeder')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] persona-feeder error: ${msg}`)
      cronHealth.fail('persona_feeder', msg)
    } finally {
      personaFeederRunning = false
    }
  })

  // Pattern synthesis: runs weekly (default: Sunday 2am, configurable via PATTERN_SYNTH_CRON).
  // Pulls last 30d of companion writes, identifies recurring patterns via DeepSeek,
  // writes synthesis back to companion_journal tagged [pattern_synthesis].
  console.log(`[ingestion] pattern-synth cron: ${config.patternSynthCronSchedule}`)
  cron.schedule(config.patternSynthCronSchedule, async () => {
    if (patternSynthRunning) {
      console.warn('[ingestion] pattern-synth still running from previous tick, skipping')
      return
    }
    patternSynthRunning = true
    console.log('[ingestion] pattern-synth tick: running pattern synthesis')
    cronHealth.start('pattern_synth')
    try {
      await runPatternSynthesis(config)
      cronHealth.complete('pattern_synth')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] pattern-synth error: ${msg}`)
      cronHealth.fail('pattern_synth', msg)
    } finally {
      patternSynthRunning = false
    }
  })

  // Stale detection: check every hour, log STALE warnings for overdue jobs.
  cron.schedule('0 * * * *', () => cronHealth.checkStale())
}
