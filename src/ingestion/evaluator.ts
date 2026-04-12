// src/ingestion/evaluator.ts
//
// Drift evaluator: compare a companion's recent persona_blocks against their
// identity basin attractors. Classify growth vs pressure drift. Write results
// back to Halseth.
//
// Called by the scheduler (every 6h). Surface-agnostic -- only reads/writes Halseth.

import type { IngestionConfig } from "./types.js";
import type { OpenAIEmbedder } from "../embeddings/openai-embedder.js";

export interface DriftThresholds {
  stableThreshold: number;   // avg_distance < this = stable (default 0.25)
  pressureJump: number;      // jump from last score >= this = pressure (default 0.15)
  pressureAbsolute: number;  // score >= this = always pressure (default 0.50)
}

export type DriftType = "stable" | "growth" | "pressure";

// Pure function -- testable without any I/O
export function classifyDrift(
  avgScore: number,
  previousScore: number | null,
  thresholds: DriftThresholds,
): DriftType {
  if (avgScore >= thresholds.pressureAbsolute) return "pressure";
  if (avgScore < thresholds.stableThreshold) return "stable";
  // Elevated but below absolute
  if (previousScore === null) return "growth"; // first run, can't measure jump
  const jump = avgScore - previousScore;
  return jump >= thresholds.pressureJump ? "pressure" : "growth";
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

interface BasinRow {
  id: string;
  basin_name: string;
  embedding: string; // JSON float array
}

interface HistoryRow {
  drift_score: number;
  drift_type: string;
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
  const thresholds: DriftThresholds = {
    stableThreshold: parseFloat(process.env.DRIFT_STABLE_THRESHOLD ?? "0.25"),
    pressureJump: parseFloat(process.env.DRIFT_PRESSURE_JUMP ?? "0.15"),
    pressureAbsolute: parseFloat(process.env.DRIFT_PRESSURE_ABSOLUTE ?? "0.50"),
  };
  const blocksLimit = parseInt(process.env.DRIFT_BLOCKS_LIMIT ?? "50", 10);

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

      // 5. Fetch previous score for trajectory
      const historyData = await halsethGet(
        `${config.halsethUrl}/companion-growth/basin-history/${companionId}?limit=1`,
        config.halsethSecret,
      ) as { history?: HistoryRow[] };

      const previousScore = historyData.history?.[0]?.drift_score ?? null;

      // 6. Classify
      const driftType = classifyDrift(avgScore, previousScore, thresholds);
      console.log(`[evaluator] ${companionId}: avg=${avgScore.toFixed(3)} previous=${previousScore?.toFixed(3) ?? 'null'} type=${driftType} worst=${worstBasin}`);

      // 7. Write basin history record
      const historyResult = await halsethPost(`${config.halsethUrl}/companion-growth/basin-history`, config.halsethSecret, {
        companion_id: companionId,
        drift_score: avgScore,
        drift_type: driftType,
        worst_basin: worstBasin,
        notes: `blocks_analyzed=${blocks.length} basins_checked=${basins.length}`,
      }) as { id?: string };

      // 7b. If growth is sustained (this run AND previous run both classified growth),
      // mark as caleth_confirmed -- intentional expansion, not noise or pressure creep.
      const previousDriftType = historyData.history?.[0]?.drift_type ?? null;
      if (driftType === "growth" && previousDriftType === "growth" && historyResult.id) {
        console.log(`[evaluator] ${companionId}: sustained growth -- marking caleth_confirmed`);
        await halsethPost(
          `${config.halsethUrl}/companion-growth/basin-history/${historyResult.id}/confirm`,
          config.halsethSecret,
          {},
        );
      }

      // 8. If pressure: write journal note tagged drift_flag
      if (driftType === "pressure") {
        console.log(`[evaluator] ${companionId}: PRESSURE DRIFT -- writing flag`);
        const noteContent = `[drift_flag] Pressure drift detected. avg_distance=${avgScore.toFixed(3)} (previous: ${previousScore?.toFixed(3) ?? 'first_run'}). Worst drifted basin: ${worstBasin}. Review recent sessions for sustained asymmetric register pressure. Self-return recommended.`;
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
