// surprisal-gate.ts -- predictive-coding write gate for the streaming Discord
// indexer (Zikkaron predictive_coding.py, lean port, 2026-06-12).
// A message whose max similarity to recent same-channel chunks exceeds the
// threshold is unsurprising -> dropped (the durable record still arrives via
// session synthesis; discord-live is recall enrichment, not archive).
// ADAPTIVE: each consecutive gate lowers the effective threshold by `step`
// (never below `floor`), so incremental progress eventually lands even when
// phrased similarly. Any stored message resets the channel to base.

export interface SurprisalConfig {
  base: number;
  floor: number;
  step: number;
}

const consecutiveGated = new Map<string, number>();

export function resetSurprisalState(): void {
  consecutiveGated.clear();
}

export function evaluateSurprisal(
  channelId: string,
  maxSim: number,
  cfg: SurprisalConfig,
): { gated: boolean; threshold: number } {
  const n = consecutiveGated.get(channelId) ?? 0;
  const threshold = Math.max(cfg.floor, cfg.base - cfg.step * n);
  const gated = maxSim >= threshold;
  consecutiveGated.set(channelId, gated ? n + 1 : 0);
  return { gated, threshold };
}
