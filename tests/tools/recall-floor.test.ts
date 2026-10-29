import { describe, it, expect, vi } from "vitest";
import { parseFloor } from "../../src/tools/retrieval.js";

describe("parseFloor (S-5)", () => {
  it("uses the fallback for undefined, blank and malformed values, never NaN", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseFloor(undefined, 0.3)).toBe(0.3);
    expect(parseFloor("  ", 0.3)).toBe(0.3);
    expect(parseFloor("abc", 0.4)).toBe(0.4);
    expect(parseFloor("Infinity", 0.4)).toBe(0.4);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("accepts valid numbers including 0", () => {
    expect(parseFloor("0.55", 0.3)).toBe(0.55);
    expect(parseFloor("0", 0.3)).toBe(0);
  });
});
