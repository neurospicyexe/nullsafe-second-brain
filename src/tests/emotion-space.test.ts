import { describe, it, expect } from "vitest";
import { emotionResonance } from "../store/emotion-space.js";

describe("emotionResonance", () => {
  it("returns max weight for identical labels", () => {
    expect(emotionResonance("joy", "joy", 0.08)).toBeCloseTo(0.08, 5);
  });
  it("gives near-neighbours a partial boost between 0 and weight", () => {
    const r = emotionResonance("joy", "serenity", 0.08);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.08);
  });
  it("gives opposite emotions near-zero boost", () => {
    const r = emotionResonance("joy", "grief", 0.08);
    expect(r).toBeLessThan(0.02);
  });
  it("ranks a nearer emotion above a farther one for the same mood", () => {
    const near = emotionResonance("serenity", "calm", 0.08);
    const far = emotionResonance("rage", "calm", 0.08);
    expect(near).toBeGreaterThan(far);
  });
  it("returns 0 when either label is unknown or null", () => {
    expect(emotionResonance("joy", "asdf", 0.08)).toBe(0);
    expect(emotionResonance(null, "joy", 0.08)).toBe(0);
    expect(emotionResonance("joy", null, 0.08)).toBe(0);
  });
  it("returns 0 when weight is 0 (disabled)", () => {
    expect(emotionResonance("joy", "joy", 0)).toBe(0);
  });
  it("is case- and whitespace-insensitive on labels", () => {
    expect(emotionResonance("  JOY ", "Joy", 0.08)).toBeCloseTo(0.08, 5);
  });
  it("never exceeds the weight (stays a nudge)", () => {
    for (const a of ["joy", "fear", "anger", "trust", "grief", "calm"]) {
      expect(emotionResonance(a, "joy", 0.08)).toBeLessThanOrEqual(0.08 + 1e-9);
    }
  });
});
