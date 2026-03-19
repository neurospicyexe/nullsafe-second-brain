import { describe, it, expect } from "vitest";
import { paragraphChunk, contextPrefix } from "../indexer.js";

describe("paragraphChunk", () => {
  it("splits on double newlines", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird.";
    const chunks = paragraphChunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    const combined = chunks.map(c => c.text).join(" ");
    expect(combined).toContain("First paragraph");
    expect(combined).toContain("Second paragraph");
  });

  it("keeps chunks under maxChars", () => {
    const chunks = paragraphChunk("word ".repeat(500), 200, 0);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(220);
  });

  it("overlaps: second chunk starts with tail of first", () => {
    const text = "A".repeat(150) + "\n\n" + "B".repeat(150);
    const chunks = paragraphChunk(text, 160, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].text.startsWith("A".repeat(40))).toBe(true);
  });

  it("assigns chunk_index sequentially from 0", () => {
    const chunks = paragraphChunk("para one\n\npara two\n\npara three");
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("returns empty array for blank input", () => {
    expect(paragraphChunk("")).toEqual([]);
    expect(paragraphChunk("   \n\n  ")).toEqual([]);
  });

  it("extracts section heading into chunk.section", () => {
    const text = "## My Section\n\nContent under section.\n\nMore content.";
    const chunks = paragraphChunk(text);
    const contentChunks = chunks.filter(c => c.text.includes("Content") || c.text.includes("More"));
    expect(contentChunks.every(c => c.section === "My Section")).toBe(true);
  });

  it("section is empty string when no heading precedes chunk", () => {
    expect(paragraphChunk("Just a paragraph.")[0].section).toBe("");
  });
});

describe("contextPrefix", () => {
  it("includes path, companion, contentType, and section", () => {
    const p = contextPrefix({ path: "Companions/Drevan/rosie.md", companion: "drevan", contentType: "health", section: "2024 Diagnosis" });
    expect(p).toContain("Companions/Drevan/rosie.md");
    expect(p).toContain("companion:drevan");
    expect(p).toContain("health");
    expect(p).toContain("2024 Diagnosis");
  });

  it("omits companion field when null", () => {
    const p = contextPrefix({ path: "a.md", companion: null, contentType: "study", section: "" });
    expect(p).not.toContain("companion:");
  });

  it("omits section line when section is empty", () => {
    const p = contextPrefix({ path: "a.md", companion: null, contentType: "note", section: "" });
    expect(p).not.toContain("##");
  });
});
