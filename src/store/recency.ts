// Recency nudge for hybrid search scoring.
//
// THE GAP THIS CLOSES (2026-07-31). `hybridSearch` scored
//     0.7*cosine + 0.3*bm25 + emotionResonance + metamemory
// and that formula contained NO time term at all. `created_at` sits in the same `embeddings` row as
// the vector and is selected on every single query -- it was simply never used. So two chunks with
// equal cosine ranked identically whether one was written last night or in April.
//
// What that cost, concretely: asked "Fargo season 4, which episode did we watch last," the top hit
// was a June entry about FINISHING the final season. Not a retrieval failure -- a retrieval success
// returning the wrong era with total confidence. Raziel's read was exact: "if there's no concept of
// when things happen, doesn't that affect the order of things." It does, and this was the line.
//
// A BOOST FOR NEW, NOT A PENALTY FOR OLD. This is the load-bearing design choice and it is a direct
// constraint from Raziel: old material must stay findable when he brings it up. So the term is
// strictly >= 0 -- fresh chunks are lifted, aged ones are left exactly where they already were.
// Nothing can ever rank LOWER than it does today because of its age, and no amount of age can push a
// chunk out of the result set. Age breaks ties; it never gates, and it never overrides meaning.
//
// Same family as `emotionResonance` and the metamemory nudge: additive, bounded, env-tunable, and
// incapable of excluding anything.

/** Default weight. Deliberately in the same band as emotionResonance (0.08) and metamemory (±0.05):
 *  enough to break a near-tie between an old and a recent chunk, not enough to outrank a genuinely
 *  better semantic match. Tune via SB_RECENCY_WEIGHT; 0 disables. */
export const DEFAULT_RECENCY_WEIGHT = 0.12;

/** Days for the boost to halve. 30d means "this month" reads as current, a June note competing with
 *  a late-July note keeps a visible gap, and material older than a season flattens out near 0 rather
 *  than being actively suppressed. */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export function recencyWeight(): number {
  const raw = Number(process.env["SB_RECENCY_WEIGHT"] ?? DEFAULT_RECENCY_WEIGHT);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function recencyHalfLifeDays(): number {
  const raw = Number(process.env["SB_RECENCY_HALF_LIFE_DAYS"] ?? DEFAULT_RECENCY_HALF_LIFE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECENCY_HALF_LIFE_DAYS;
}

/**
 * Bounded, non-negative recency boost in [0, weight].
 *
 * Returns exactly 0 -- never NaN, never negative -- for a missing, empty or unparseable timestamp.
 * That matters more than it looks: this value is added to a score that is then sorted, and a single
 * NaN propagates through `sort` and scrambles the entire result ordering. A chunk with no usable date
 * must be treated as "no information about age", which means no adjustment, not a penalty.
 */
export function recencyBoost(
  createdAt: string | null | undefined,
  weight: number,
  halfLifeDays: number = recencyHalfLifeDays(),
  now: number = Date.now(),
): number {
  if (weight <= 0 || !Number.isFinite(weight)) return 0;
  if (!createdAt) return 0;

  // SQLite `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" with no zone marker, which Date.parse
  // reads as LOCAL time while the value is UTC. Normalise to an explicit UTC instant so a chunk is
  // not scored hours off (and so the machine's timezone cannot change search results).
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(createdAt)
    ? createdAt.replace(" ", "T") + "Z"
    : createdAt;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return 0;

  // Clamp at 0: a future timestamp (clock skew between the VPS and whatever wrote the row) must not
  // earn MORE than a brand-new chunk.
  const ageDays = Math.max(0, (now - t) / MS_PER_DAY);
  if (!Number.isFinite(ageDays)) return 0;

  const boost = weight * Math.pow(2, -ageDays / halfLifeDays);
  return Number.isFinite(boost) ? Math.max(0, Math.min(weight, boost)) : 0;
}
