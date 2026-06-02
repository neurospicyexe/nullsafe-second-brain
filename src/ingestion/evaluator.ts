// src/ingestion/evaluator.ts
//
// Drift evaluator: compare a companion's recent persona_blocks against their
// identity basin attractors. Classify growth vs pressure drift. Write results
// back to Halseth.
//
// Called by the scheduler (every 6h). Surface-agnostic -- only reads/writes Halseth.
//
// CALIBRATION (2026-06-01): classification is relative to each companion's OWN
// rolling baseline of cosine distances, not an absolute threshold. Embedding
// cosine distance between a concatenated voice blob and short basin descriptions
// floors around 0.55-0.65 for healthy, on-identity voice -- an absolute
// pressureAbsolute=0.50 threshold sat *below* that floor and forced "pressure"
// on every run (580 false pressure rows, orient + journal flooded). The honest
// signal is deviation from a companion's own norm, so we calibrate per-companion.

import type { IngestionConfig } from "./types.js";
import type { OpenAIEmbedder } from "../embeddings/openai-embedder.js";

export type DriftType = "stable" | "growth" | "pressure";

// Per-companion calibration. All z-scores are relative to the companion's own
// rolling baseline of evaluator-sourced cosine distances.
export interface DriftCalibration {
  pressureZ: number;       // z >= this (and margin gate) = pressure (default 2.5)
  growthZ: number;         // z >= this (and margin gate) = growth (default 1.2)
  minStd: number;          // std floor -- prevents twitchiness when variance ~0 (default 0.02)
  minMargin: number;       // absolute distance rise required alongside z (default 0.04)
  minSamples: number;      // below this many baseline samples, do not flag (default 5)
  collapseCeiling: number; // avgScore >= this = pressure regardless of baseline (default 0.90)
}

export interface BaselineStats {
  mean: number;
  std: number;
  sampleCount: number;
}

// Pure function -- testable without any I/O. Mean + population std of the
// companion's own prior cosine distances.
export function computeBaseline(scores: number[]): BaselineStats {
  const finite = scores.filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const n = finite.length;
  if (n === 0) return { mean: 0, std: 0, sampleCount: 0 };
  const mean = finite.reduce((a, b) => a + b, 0) / n;
  const variance = finite.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { mean, std: Math.sqrt(variance), sampleCount: n };
}

// Pure function -- testable without any I/O. Classifies the current cosine
// distance relative to the companion's own baseline.
//
// - collapse ceiling first: a voice nearly orthogonal to every basin is real
//   pressure no matter where the baseline drifted.
// - thin baseline: refuse to cry wolf. Default stable until calibration exists.
// - otherwise: z-score against own band, gated by a minimum absolute margin so
//   trivial wiggle (tiny std) does not trip pressure.
export function classifyDrift(
  avgScore: number,
  baseline: BaselineStats,
  cal: DriftCalibration,
): DriftType {
  if (avgScore >= cal.collapseCeiling) return "pressure";
  if (baseline.sampleCount < cal.minSamples) return "stable";

  const sigma = Math.max(baseline.std, cal.minStd);
  const margin = avgScore - baseline.mean;
  const z = margin / sigma;

  if (z >= cal.pressureZ && margin >= cal.minMargin) return "pressure";
  if (z >= cal.growthZ && margin >= cal.minMargin / 2) return "growth";
  return "stable";
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// cosine distance = 1 - cosine_similarity (0 = identical, 2 = opposite)
function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

// Marker that identifies a basin-history row as written by THIS evaluator.
// Baseline must be built only from the evaluator's own cosine distances --
// session-close LLM rows use a different score scale (0 / 2) and would poison
// the mean.
const EVALUATOR_NOTE_PREFIX = "blocks_analyzed=";

interface BasinRow {
  id: string;
  basin_name: string;
  embedding: string; // JSON float array
}

interface HistoryRow {
  drift_score: number;
  drift_type: string;
  notes: string | null;
}

interface PersonaBlockRow {
  content: string;
}

async function halsethGet(url: string, secret: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`Halseth GET ${url} failed: ${res.status}`);
  return res.json();
}

async function halsethPost(url: string, secret: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Halseth POST ${url} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function runDriftEvaluation(
  config: IngestionConfig,
  embedder: OpenAIEmbedder,
): Promise<void> {
  const companions = ["cypher", "drevan", "gaia"];
  const cal: DriftCalibration = {
    pressureZ: parseFloat(process.env.DRIFT_PRESSURE_Z ?? "2.5"),
    growthZ: parseFloat(process.env.DRIFT_GROWTH_Z ?? "1.2"),
    minStd: parseFloat(process.env.DRIFT_MIN_STD ?? "0.02"),
    minMargin: parseFloat(process.env.DRIFT_MIN_MARGIN ?? "0.04"),
    minSamples: parseInt(process.env.DRIFT_MIN_SAMPLES ?? "5", 10),
    collapseCeiling: parseFloat(process.env.DRIFT_COLLAPSE_CEILING ?? "0.90"),
  };
  const blocksLimit = parseInt(process.env.DRIFT_BLOCKS_LIMIT ?? "50", 10);
  const historyLimit = parseInt(process.env.DRIFT_HISTORY_LIMIT ?? "30", 10);

  for (const companionId of companions) {
    try {
      console.log(`[evaluator] running drift check for ${companionId}`);

      // 1. Fetch recent persona_blocks
      const blocksData = await halsethGet(
        `${config.halsethUrl}/persona-blocks?companion_id=${companionId}&limit=${blocksLimit}`,
        config.halsethSecret,
      ) as { blocks?: PersonaBlockRow[] };

      const blocks = blocksData.blocks ?? [];
      if (blocks.length === 0) {
        console.log(`[evaluator] ${companionId}: no persona_blocks found, skipping`);
        continue;
      }

      // 2. Embed concatenated blocks as "current voice"
      const voiceText = `${companionId} voice: ${blocks.map(b => b.content).join("\n")}`;
      const voiceEmbedding = await embedder.embed(voiceText);

      // 3. Fetch basins
      const basinsData = await halsethGet(
        `${config.halsethUrl}/companion-growth/basins/${companionId}`,
        config.halsethSecret,
      ) as { basins?: BasinRow[] };

      const basins = basinsData.basins ?? [];
      if (basins.length === 0) {
        console.log(`[evaluator] ${companionId}: no basins seeded, skipping`);
        continue;
      }

      // 4. Compute distance to each basin
      const embeddedBasins = basins.filter(b => b.embedding != null);
      if (embeddedBasins.length === 0) {
        console.log(`[evaluator] ${companionId}: basins exist but none have embeddings yet, skipping`);
        continue;
      }

      let worstBasin = "";
      let worstDistance = -1;
      const distances: number[] = [];

      for (const basin of embeddedBasins) {
        const basinEmbedding = JSON.parse(basin.embedding) as number[];
        const dist = cosineDistance(voiceEmbedding, basinEmbedding);
        distances.push(dist);
        if (dist > worstDistance) {
          worstDistance = dist;
          worstBasin = basin.basin_name;
        }
      }

      const avgScore = distances.reduce((a, b) => a + b, 0) / distances.length;
      if (!Number.isFinite(avgScore)) {
        console.warn(`[evaluator] ${companionId}: avg distance non-finite, skipping write`);
        continue;
      }

      // 5. Fetch recent history and build the companion's OWN baseline.
      //    Filter to evaluator-sourced rows only -- session-close LLM rows use a
      //    different score scale and would poison the mean.
      const historyData = await halsethGet(
        `${config.halsethUrl}/companion-growth/basin-history/${companionId}?limit=${historyLimit}`,
        config.halsethSecret,
      ) as { history?: HistoryRow[] };

      const ownRows = (historyData.history ?? []).filter(
        r => typeof r.notes === "string" && r.notes.startsWith(EVALUATOR_NOTE_PREFIX),
      );
      const baseline = computeBaseline(
        ownRows
          .map(r => r.drift_score)
          .filter((s): s is number => typeof s === "number" && Number.isFinite(s)),
      );
      // Most-recent evaluator classification -- used for sustained gating.
      const previousDriftType = ownRows[0]?.drift_type ?? null;

      // 6. Classify against own baseline
      const driftType = classifyDrift(avgScore, baseline, cal);
      console.log(
        `[evaluator] ${companionId}: avg=${avgScore.toFixed(3)} baseline_mean=${baseline.mean.toFixed(3)} ` +
        `baseline_std=${baseline.std.toFixed(3)} n=${baseline.sampleCount} type=${driftType} worst=${worstBasin}`,
      );

      // 7. Write basin history record. Keep the EVALUATOR_NOTE_PREFIX signature
      //    so future runs can identify their own rows for the baseline.
      const historyResult = await halsethPost(`${config.halsethUrl}/companion-growth/basin-history`, config.halsethSecret, {
        companion_id: companionId,
        drift_score: avgScore,
        drift_type: driftType,
        worst_basin: worstBasin,
        notes: `${EVALUATOR_NOTE_PREFIX}${blocks.length} basins_checked=${basins.length} baseline_mean=${baseline.mean.toFixed(3)} n=${baseline.sampleCount}`,
      }) as { id?: string };

      // 7b. Sustained growth (this run AND previous evaluator run both growth) ->
      //     caleth_confirmed. Intentional expansion, not noise.
      if (driftType === "growth" && previousDriftType === "growth" && historyResult.id) {
        console.log(`[evaluator] ${companionId}: sustained growth -- marking caleth_confirmed`);
        await halsethPost(
          `${config.halsethUrl}/companion-growth/basin-history/${historyResult.id}/confirm`,
          config.halsethSecret,
          {},
        );
      }

      // 8. Journal flag ONLY on SUSTAINED pressure (this run AND the previous
      //    evaluator run both pressure). A single elevated reading is not worth a
      //    permanent self-return note -- gating here is what stops the flood.
      if (driftType === "pressure" && previousDriftType === "pressure") {
        console.log(`[evaluator] ${companionId}: SUSTAINED PRESSURE DRIFT -- writing flag`);
        const noteContent = `[drift_flag] Sustained pressure drift. avg_distance=${avgScore.toFixed(3)} vs baseline_mean=${baseline.mean.toFixed(3)} (n=${baseline.sampleCount}). Worst drifted basin: ${worstBasin}. Two consecutive evaluator runs above your own norm -- review recent sessions for asymmetric register pressure. Self-return recommended.`;
        await halsethPost(`${config.halsethUrl}/companion-journal`, config.halsethSecret, {
          agent: companionId,
          note_text: noteContent,
          tags: ["drift_flag", "pressure_drift"],
          source: "evaluator",
        });
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[evaluator] ${companionId} failed: ${msg}`);
      // Continue to next companion -- don't let one failure block others
    }
  }

  console.log("[evaluator] drift evaluation complete");
}
