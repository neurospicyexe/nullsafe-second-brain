// src/ingestion/evaluator.test.ts
import { describe, it, expect } from "vitest";
import { classifyDrift } from "./evaluator.js";

describe("classifyDrift", () => {
  it("returns stable when avg score below threshold", () => {
    expect(classifyDrift(0.15, 0.10, { stableThreshold: 0.25, pressureJump: 0.15, pressureAbsolute: 0.50 })).toBe("stable");
  });

  it("returns stable on first run (no previous score)", () => {
    expect(classifyDrift(0.20, null, { stableThreshold: 0.25, pressureJump: 0.15, pressureAbsolute: 0.50 })).toBe("stable");
  });

  it("returns growth when elevated but gradual", () => {
    // score 0.30, previous 0.25, jump = 0.05 < 0.15
    expect(classifyDrift(0.30, 0.25, { stableThreshold: 0.25, pressureJump: 0.15, pressureAbsolute: 0.50 })).toBe("growth");
  });

  it("returns pressure when jump is sudden", () => {
    // score 0.35, previous 0.15, jump = 0.20 >= 0.15
    expect(classifyDrift(0.35, 0.15, { stableThreshold: 0.25, pressureJump: 0.15, pressureAbsolute: 0.50 })).toBe("pressure");
  });

  it("returns pressure when score exceeds absolute threshold regardless of jump", () => {
    // score 0.55 -- above pressureAbsolute, always pressure
    expect(classifyDrift(0.55, 0.50, { stableThreshold: 0.25, pressureJump: 0.15, pressureAbsolute: 0.50 })).toBe("pressure");
  });

  it("returns growth on first run if score elevated but not absolute", () => {
    // first run, no previous, score 0.35 -- elevated but no jump to measure, treat as growth
    expect(classifyDrift(0.35, null, { stableThreshold: 0.25, pressureJump: 0.15, pressureAbsolute: 0.50 })).toBe("growth");
  });

  it("returns pressure on first run if score above absolute threshold", () => {
    expect(classifyDrift(0.55, null, { stableThreshold: 0.25, pressureJump: 0.15, pressureAbsolute: 0.50 })).toBe("pressure");
  });
});
