import cron from "node-cron";
import type { SecondBrainConfig } from "./config.js";
import type { buildSynthesisTools } from "./tools/synthesis.js";
import type { VectorStore } from "./store/vector-store.js";
import type { OpenAIEmbedder } from "./embeddings/openai-embedder.js";

type SynthesisTools = ReturnType<typeof buildSynthesisTools>;

export async function setupTriggers(
  config: SecondBrainConfig,
  synthesis: SynthesisTools,
  store: VectorStore,
  embedder: OpenAIEmbedder,
): Promise<void> {
  if (config.triggers.scheduled.enabled) {
    cron.schedule(config.triggers.scheduled.cron, async () => {
      console.error("[second-brain] Running scheduled synthesis...");
      try {
        await synthesis.sb_run_patterns();
        if (config.patterns.hearth_summary) {
          await synthesis.sb_run_patterns({ summary: true });
        }
      } catch (err) {
        console.error("[second-brain] Scheduled synthesis error:", err);
      }
    });
    console.error(`[second-brain] Scheduled synthesis enabled: ${config.triggers.scheduled.cron}`);
  }

  if (config.triggers.on_demand) {
    console.error("[second-brain] On-demand tools enabled.");
  }

  if (config.triggers.event_driven.enabled) {
    console.error("[second-brain] Event-driven triggers configured (webhook support pending halseth v2).");
  }

  try {
    const { loadIngestionConfig } = await import('./ingestion/config.js')
    const { startIngestionScheduler } = await import('./ingestion/scheduler.js')
    const ingestionConfig = loadIngestionConfig()
    startIngestionScheduler(ingestionConfig, store, embedder)
  } catch (err) {
    console.warn('[ingestion] scheduler not started:', err instanceof Error ? err.message : err)
  }
}
