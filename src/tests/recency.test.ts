// Recency nudge (2026-07-31).
//
// hybridSearch scored `0.7*cosine + 0.3*bm25 + emotionResonance + metamemory` -- no time term at all,
// while `created_at` sat in every row it selected. Live consequence: "Fargo season 4, which episode
// did we watch last" returned a JUNE entry about finishing the final season as the top hit.
//
// These tests pin the two things that must survive any tuning of the weights:
//   1. Fresher wins a tie.
//   2. Older is never PUSHED DOWN. Raziel's constraint, stated directly: old material has to stay
//      findable when he brings it up. So the term is a boost for new, not a penalty for old, and
//      nothing may rank lower than it did before this term existed.

import { describe, it, expect } from "vitest";
import {
  recencyBoost, recencyWeight, recencyHalfLifeDays,
  DEFAULT_RECENCY_WEIGHT, DEFAULT_RECENCY_HALF_LIFE_DAYS,
} from "../store/recency.js";

const NOW = Date.parse("2026-07-31T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const W = 0.12;

describe("recencyBoost", () => {
  it("is never negative -- old material is left where it was, never demoted", () => {
    for (const age of [0, 1, 7, 30, 90, 365, 5000]) {
      expect(recencyBoost(daysAgo(age), W, 30, NOW)).toBeGreaterThanOrEqual(0);
    }
  });

  it("never exceeds the weight, so it cannot outrank a genuinely better semantic match", () => {
    for (const age of [0, 0.001, 5, 40]) {
      expect(recencyBoost(daysAgo(age), W, 30, NOW)).toBeLessThanOrEqual(W);
    }
  });

  it("halves at the half-life", () => {
    const fresh = recencyBoost(daysAgo(0), W, 30, NOW);
    const oneHalfLife = recencyBoost(daysAgo(30), W, 30, NOW);
    expect(fresh).toBeCloseTo(W, 6);
    expect(oneHalfLife).toBeCloseTo(W / 2, 6);
  });

  it("separates the ACTUAL failing case: a June summary vs a late-July note", () => {
    // The real rows: a June entry about finishing Fargo, and a 2026-07-30 note about S4 power
    // dynamics. Equal cosine before this change, so ordering between them was arbitrary.
    const june = recencyBoost("2026-06-05T12:00:00Z", W, 30, NOW);
    const july = recencyBoost("2026-07-30T21:00:00Z", W, 30, NOW);
    expect(july).toBeGreaterThan(june);
    // And the gap must be big enough to actually break a tie in a 0..1 normalised score, not a
    // rounding artefact.
    expect(july - june).toBeGreaterThan(0.05);
  });

  it("returns 0 -- never NaN -- for junk timestamps", () => {
    // A single NaN added to a score poisons the whole `sort` and scrambles every result, so this is
    // not a cosmetic guard.
    for (const bad of [null, undefined, "", "not a date", "0000", "2026-13-45T99:99:99Z"]) {
      const out = recencyBoost(bad as string | null, W, 30, NOW);
      expect(Number.isNaN(out)).toBe(false);
      expect(out).toBe(0);
    }
  });

  it("treats a naked SQLite timestamp as UTC, not local time", () => {
    // SQLite datetime('now') writes "YYYY-MM-DD HH:MM:SS" with no zone; Date.parse reads that as
    // LOCAL, so without normalisation the same chunk scores differently depending on the machine's
    // timezone -- and search results would depend on where the process runs.
    const naked = recencyBoost("2026-07-31 00:00:00", W, 30, NOW);
    const explicit = recencyBoost("2026-07-31T00:00:00Z", W, 30, NOW);
    expect(naked).toBeCloseTo(explicit, 9);
  });

  it("a future timestamp earns no more than a brand-new chunk", () => {
    // Clock skew between the VPS and whatever wrote the row must not buy extra rank.
    const future = recencyBoost(new Date(NOW + 10 * 86_400_000).toISOString(), W, 30, NOW);
    expect(future).toBeLessThanOrEqual(W);
    expect(future).toBeCloseTo(W, 6);
  });

  it("weight 0 disables the term completely", () => {
    expect(recencyBoost(daysAgo(0), 0, 30, NOW)).toBe(0);
    expect(recencyBoost(daysAgo(0), -1, 30, NOW)).toBe(0);
    expect(recencyBoost(daysAgo(0), NaN, 30, NOW)).toBe(0);
  });

  it("is monotonic in age, so it can never reorder two chunks against their true sequence", () => {
    const ages = [0, 1, 3, 7, 14, 30, 60, 120, 365];
    const boosts = ages.map(a => recencyBoost(daysAgo(a), W, 30, NOW));
    for (let i = 1; i < boosts.length; i++) {
      expect(boosts[i]).toBeLessThanOrEqual(boosts[i - 1]!);
    }
  });
});

describe("env configuration", () => {
  const reset = (k: string, v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

  it("defaults sit in the same band as the other nudges (resonance 0.08, metamemory 0.05)", () => {
    expect(DEFAULT_RECENCY_WEIGHT).toBeGreaterThan(0);
    expect(DEFAULT_RECENCY_WEIGHT).toBeLessThan(0.3);   // must not rival the 0.7 cosine term
    expect(DEFAULT_RECENCY_HALF_LIFE_DAYS).toBeGreaterThan(0);
  });

  it("SB_RECENCY_WEIGHT=0 turns it off, and garbage falls back instead of producing NaN", () => {
    const prevW = process.env["SB_RECENCY_WEIGHT"];
    const prevH = process.env["SB_RECENCY_HALF_LIFE_DAYS"];
    try {
      reset("SB_RECENCY_WEIGHT", "0");
      expect(recencyWeight()).toBe(0);
      reset("SB_RECENCY_WEIGHT", "banana");
      expect(recencyWeight()).toBe(0);
      reset("SB_RECENCY_HALF_LIFE_DAYS", "banana");
      expect(recencyHalfLifeDays()).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
    } finally {
      reset("SB_RECENCY_WEIGHT", prevW);
      reset("SB_RECENCY_HALF_LIFE_DAYS", prevH);
    }
  });
});
