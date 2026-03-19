import { describe, it, expect } from "vitest";
import { paragraphChunk, contextPrefix } from "../indexer.js";

describe("paragraphChunk", () => {
  it("merges short paragraphs into one chunk when under maxChars", () => {
    const chunks = paragraphChunk("Para one.\n\nPara two.\n\nPara three.", 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Para one");
    expect(chunks[0].text).toContain("Para three");
    expect(chunks[0].index).toBe(0);
  });

  it("emits chunk when next paragraph would exceed maxChars", () => {
    const longA = "A".repeat(600);
    const longB = "B".repeat(600);
    const chunks = paragraphChunk(`${longA}\n\n${longB}`, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].text).toContain("A");
    expect(chunks[1].text).toContain("B");
  });

  it("prepends overlap tail from previous chunk to next chunk", () => {
    const longA = "A".repeat(600);
    const longB = "B".repeat(600);
    const chunks = paragraphChunk(`${longA}\n\n${longB}`, 1000, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Second chunk should start with tail of first chunk
    expect(chunks[1].text.substring(0, 100)).toBe("A".repeat(100));
  });

  it("assigns sequential chunk_index values", () => {
    const longA = "A".repeat(600);
    const longB = "B".repeat(600);
    const chunks = paragraphChunk(`${longA}\n\n${longB}`, 1000);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("returns empty array for empty input", () => {
    expect(paragraphChunk("")).toHaveLength(0);
    expect(paragraphChunk("   ")).toHaveLength(0);
  });

  it("splits large paragraph on sentence boundaries", () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence ${i} ends here.`);
    const longPara = sentences.join(" ");
    const chunks = paragraphChunk(longPara, 200, 0);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.text.length).toBeLessThanOrEqual(220));
  });

  it("tracks section heading for chunks", () => {
    const text = "## My Section\n\nParagraph one.\n\nParagraph two.";
    const chunks = paragraphChunk(text, 1000);
    // All content merged into one chunk, section should be set
    expect(chunks[0].section).toBe("My Section");
  });

  it("returns empty section when no heading present", () => {
    const chunks = paragraphChunk("Just some text here.", 1000);
    expect(chunks[0].section).toBe("");
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
