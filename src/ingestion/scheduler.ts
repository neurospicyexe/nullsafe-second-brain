import cron from 'node-cron'
import type { IngestionConfig } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import type { VaultAdapter } from '../adapters/vault-adapter.js'
import { createPipeline } from './pipeline.js'
import { runGapDetector } from './gap-detector.js'
import { runDriftEvaluation } from './evaluator.js'
import { runSitPrompts } from './sit-prompts.js'
import { runPersonaFeeder } from './persona-feeder.js'
import { processCorpus } from './corpus.js'
import { runVaultMaterializer } from './vault-materializer.js'
import { runInboxFiler, buildClassifyPrompt, parseDecision } from './inbox-filer.js'
import { callDeepSeek } from './deepseek-client.js'
import { Indexer } from '../indexer.js'
import { cronHealth } from './cron-health.js'

// NOTE: pattern-synthesizer.ts (runPatternSynthesis / runSignalAudit) is
// retired as of migration 0062. The autonomous worker now writes structured
// patterns directly to growth_patterns via the new evidence/prehension
// prompt + Jaccard-similarity UPSERT. The legacy weekly synthesis wrote
// unstructured text to companion_journal tagged [pattern_synthesis] and
// duplicated the new path. The file is kept for reference but the cron is
// not registered. To re-enable for a one-shot run: call runPatternSynthesis
// directly from a script, not from this scheduler.

export function startIngestionScheduler(
  config: IngestionConfig,
  store: VectorStore,
  embedder: OpenAIEmbedder,
  vault?: VaultAdapter,
): void {
  const pipeline = createPipeline(config, store, embedder)

  // Register all jobs with expected intervals before any ticks fire.
  cronHealth.register('ingestion_pipeline', 20 * 60 * 1000)
  cronHealth.register('drift_evaluator', 6 * 60 * 60 * 1000)
  cronHealth.register('sit_prompts', 12 * 60 * 60 * 1000)
  cronHealth.register('persona_feeder', 6 * 60 * 60 * 1000)
  if (vault) cronHealth.register('vault_materializer', 30 * 60 * 1000)
  cronHealth.register('thoughtform_detector', 24 * 60 * 60 * 1000)

  console.log(`[ingestion] scheduler starting, cron: ${config.cronSchedule}`)

  // Per-job running flags. node-cron callbacks are single-process so a boolean is sufficient.
  let pipelineRunning = false
  let evaluatorRunning = false
  let sitPromptsRunning = false
  let personaFeederRunning = false
  let materializerRunning = false
  let inboxFilerRunning = false
  let thoughtformRunning = false

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

  // Vault materializer: every 30 min by default (VAULT_MATERIALIZER_CRON).
  // Pulls /mind/growth/unmaterialized/<companion> for cypher/drevan/gaia,
  // writes structured .md files into the Obsidian vault under
  // Companions/<id>/growth/{journal,patterns,markers}/, then PATCHes
  // vault_path back to Halseth so the row no longer appears in subsequent
  // unmaterialized fetches. Only runs if a vault adapter was passed in.
  if (vault) {
    const vaultCron = config.vaultMaterializerCronSchedule ?? '*/30 * * * *'
    console.log(`[ingestion] vault-materializer cron: ${vaultCron}`)
    cron.schedule(vaultCron, async () => {
      if (materializerRunning) {
        console.warn('[ingestion] vault-materializer still running from previous tick, skipping')
        return
      }
      materializerRunning = true
      console.log('[ingestion] vault-materializer tick: writing growth rows to vault')
      cronHealth.start('vault_materializer')
      try {
        const stats = await runVaultMaterializer(config, vault)
        cronHealth.complete('vault_materializer')
        console.log(`[ingestion] vault-materializer done: ${stats.written} written, ${stats.failed} failed`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ingestion] vault-materializer error: ${msg}`)
        cronHealth.fail('vault_materializer', msg)
      } finally {
        materializerRunning = false
      }
    })
  } else {
    console.log('[ingestion] vault-materializer NOT registered (no VaultAdapter passed to startIngestionScheduler)')
  }

  // INBOX auto-filer: hourly (INBOX_FILER_CRON), only when INBOX_FILER=true and a
  // vault adapter exists. Hybrid mode: auto-files high-confidence notes out of
  // "00 - INBOX/" and queues uncertain ones for one-tap approval in _filing-plan.md.
  // Move-only, fully logged, reversible. Vector store stays consistent via onMoved
  // (deleteByPath + reindex at the new path).
  if (vault && config.inboxFilerEnabled) {
    const filerCron = config.inboxFilerCronSchedule ?? '15 * * * *'
    const indexer = new Indexer(vault, embedder, store)
    cronHealth.register('inbox_filer', 60 * 60 * 1000)
    console.log(`[ingestion] inbox-filer cron: ${filerCron} (mode=${config.inboxFilerMode})`)
    cron.schedule(filerCron, async () => {
      if (inboxFilerRunning) {
        console.warn('[ingestion] inbox-filer still running from previous tick, skipping')
        return
      }
      inboxFilerRunning = true
      cronHealth.start('inbox_filer')
      try {
        const stats = await runInboxFiler(
          {
            vault,
            classify: async (note) => parseDecision(
              await callDeepSeek(config.deepseekApiKey, config.deepseekModel, buildClassifyPrompt(note))
            ),
            onMoved: async (from, to) => { store.deleteByPath(from); await indexer.reindex(to) },
          },
          {
            mode: config.inboxFilerMode ?? 'hybrid',
            dryRun: false,
            confidenceThreshold: config.inboxFilerConfidence ?? 0.75,
          },
        )
        cronHealth.complete('inbox_filer')
        console.log(`[ingestion] inbox-filer done: ${stats.filed} filed, ${stats.approved} approved, ${stats.queued} queued, ${stats.failed} failed`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ingestion] inbox-filer error: ${msg}`)
        cronHealth.fail('inbox_filer', msg)
      } finally {
        inboxFilerRunning = false
      }
    })
  } else if (!config.inboxFilerEnabled) {
    console.log('[ingestion] inbox-filer NOT registered (INBOX_FILER not true)')
  }

  // Thoughtform detector: daily at 3am UTC (THOUGHTFORM_CRON).
  // POSTs /mind/growth/thoughtforms/detect on Halseth which walks recent
  // patterns across all three companions, finds Jaccard >= 0.6 cross-companion
  // clusters, and writes a 'thoughtform' marker on each participating
  // companion. The vault-materializer picks those up on its next tick.
  // Idempotent at the Halseth side (description-dedupe).
  const thoughtformCron = config.thoughtformDetectorCronSchedule ?? '0 3 * * *'
  console.log(`[ingestion] thoughtform-detector cron: ${thoughtformCron}`)
  cron.schedule(thoughtformCron, async () => {
    if (thoughtformRunning) {
      console.warn('[ingestion] thoughtform-detector still running from previous tick, skipping')
      return
    }
    thoughtformRunning = true
    cronHealth.start('thoughtform_detector')
    try {
      const res = await fetch(`${config.halsethUrl}/mind/growth/thoughtforms/detect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.halsethSecret}`,
        },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Halseth thoughtforms/detect ${res.status}: ${body.slice(0, 200)}`)
      }
      const data = await res.json() as { detected?: number; written?: number }
      console.log(`[ingestion] thoughtform-detector: detected=${data.detected ?? 0} written=${data.written ?? 0}`)
      cronHealth.complete('thoughtform_detector')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ingestion] thoughtform-detector error: ${msg}`)
      cronHealth.fail('thoughtform_detector', msg)
    } finally {
      thoughtformRunning = false
    }
  })

  // Corpus intake: optional, every 6h by default (configurable via CORPUS_CRON).
  // Only registered if CORPUS_INTAKE_DIR is set. Walks the folder recursively, indexes
  // every .md file. Existing chunks are skipped (existsByPath check) so re-runs are
  // idempotent and only new files get embedded -- safe to leave running indefinitely.
  if (config.corpusIntakeDir) {
    const corpusCron = config.corpusCronSchedule ?? '0 */6 * * *'
    console.log(`[ingestion] corpus cron: ${corpusCron}, dir: ${config.corpusIntakeDir}`)
    cronHealth.register('corpus_intake', 6 * 60 * 60 * 1000)
    let corpusRunning = false
    cron.schedule(corpusCron, async () => {
      if (corpusRunning) {
        console.warn('[ingestion] corpus still running from previous tick, skipping')
        return
      }
      corpusRunning = true
      console.log('[ingestion] corpus tick: running corpus intake')
      cronHealth.start('corpus_intake')
      try {
        await processCorpus(
          { intakeDir: config.corpusIntakeDir!, sourceType: 'historical_corpus', force: false },
          config,
          store,
          embedder,
        )
        cronHealth.complete('corpus_intake')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ingestion] corpus error: ${msg}`)
        cronHealth.fail('corpus_intake', msg)
      } finally {
        corpusRunning = false
      }
    })
  }

  // Stale detection: check every hour, log STALE warnings for overdue jobs.
  cron.schedule('0 * * * *', () => cronHealth.checkStale())
}
