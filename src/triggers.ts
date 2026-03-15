import cron from "node-cron";
import type { SecondBrainConfig } from "./config.js";
import type { buildSynthesisTools } from "./tools/synthesis.js";

type SynthesisTools = ReturnType<typeof buildSynthesisTools>;

export function setupTriggers(config: SecondBrainConfig, synthesis: SynthesisTools): void {
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
}
