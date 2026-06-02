// src/ingestion/evaluator.test.ts
import { describe, it, expect } from "vitest";
import { classifyDrift, computeBaseline, type DriftCalibration, type BaselineStats } from "./evaluator.js";

const CAL: DriftCalibration = {
  pressureZ: 2.5,
  growthZ: 1.2,
  minStd: 0.02,
  minMargin: 0.04,
  minSamples: 5,
  collapseCeiling: 0.90,
};

// A healthy, well-established baseline: scores cluster tightly around 0.61
// (this is what real embedding cosine distance looks like for on-identity voice).
const HEALTHY: BaselineStats = { mean: 0.61, std: 0.02, sampleCount: 20 };

describe("computeBaseline", () => {
  it("returns zeroed stats with no samples", () => {
    expect(computeBaseline([])).toEqual({ mean: 0, std: 0, sampleCount: 0 });
  });

  it("computes mean and population std", () => {
    const b = computeBaseline([0.60, 0.62, 0.61, 0.59, 0.63]);
    expect(b.sampleCount).toBe(5);
    expect(b.mean).toBeCloseTo(0.61, 5);
    expect(b.std).toBeGreaterThan(0);
    expect(b.std).toBeLessThan(0.02);
  });

  it("ignores non-finite values", () => {
    const b = computeBaseline([0.6, NaN, 0.62, Infinity, 0.61]);
    expect(b.sampleCount).toBe(3);
  });
});

describe("classifyDrift (calibrated)", () => {
  // THE REGRESSION: under the old absolute pressureAbsolute=0.50, a normal
  // ~0.61 reading was forced to "pressure" on every run. Calibrated, a reading
  // at the companion's own baseline is stable.
  it("classifies an at-baseline 0.61 reading as stable (regression: was forced pressure)", () => {
    expect(classifyDrift(0.61, HEALTHY, CAL)).toBe("stable");
  });

  it("classifies a below-baseline reading (more aligned than usual) as stable", () => {
    expect(classifyDrift(0.55, HEALTHY, CAL)).toBe("stable");
  });

  it("classifies a modest rise above own norm as growth", () => {
    // 0.66 vs mean 0.61, std floored to 0.02 -> z=2.5... that's pressure.
    // 0.64 -> margin 0.03, z=1.5 -> growth (z>=1.2, margin>=0.02).
    expect(classifyDrift(0.64, HEALTHY, CAL)).toBe("growth");
  });

  it("classifies a sharp rise well above own norm as pressure", () => {
    // 0.72 vs mean 0.61 -> margin 0.11, z=5.5 -> pressure.
    expect(classifyDrift(0.72, HEALTHY, CAL)).toBe("pressure");
  });

  it("flags pressure at collapse ceiling regardless of baseline", () => {
    expect(classifyDrift(0.95, HEALTHY, CAL)).toBe("pressure");
    // even with no baseline at all
    expect(classifyDrift(0.95, { mean: 0, std: 0, sampleCount: 0 }, CAL)).toBe("pressure");
  });

  it("refuses to flag on thin baseline (cold start) -> stable", () => {
    const thin: BaselineStats = { mean: 0.61, std: 0.02, sampleCount: 3 };
    expect(classifyDrift(0.80, thin, CAL)).toBe("stable");
  });

  it("does not trip on trivial wiggle when std is tiny (margin gate)", () => {
    // Very tight baseline; a 0.01 rise is z=... large, but margin 0.01 < minMargin/2.
    const tight: BaselineStats = { mean: 0.61, std: 0.001, sampleCount: 20 };
    expect(classifyDrift(0.62, tight, CAL)).toBe("stable");
  });

  it("uses minStd floor so near-zero variance cannot manufacture huge z", () => {
    // std 0 -> floored to minStd 0.02. 0.64 -> margin 0.03, z=1.5 -> growth not pressure.
    const flat: BaselineStats = { mean: 0.61, std: 0, sampleCount: 20 };
    expect(classifyDrift(0.64, flat, CAL)).toBe("growth");
  });
});
