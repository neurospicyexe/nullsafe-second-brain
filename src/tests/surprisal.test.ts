import { describe, it, expect } from "vitest";
import { VectorStore } from "../store/vector-store.js";
import { evaluateSurprisal, resetSurprisalState } from "../ingestion/surprisal-gate.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function makeStore() {
  const store = new VectorStore(join(mkdtempSync(join(tmpdir(), "sb-surprisal-")), "test.db"));
  store.initialize();
  return store;
}

// unit vector in 384-dim space, parameterized so cos(vec(a), vec(b)) = a*b + sqrt(1-a^2)*sqrt(1-b^2)
const vec = (x: number) => {
  const v = new Array(384).fill(0);
  v[0] = x;
  v[1] = Math.sqrt(Math.max(0, 1 - x * x));
  return v;
};

describe("VectorStore.maxSimilarityForPrefix", () => {
  it("returns the max cosine similarity among recent rows under a path prefix", () => {
    const store = makeStore();
    store.insert({ vault_path: "discord-live/chan1/m1.md", companion: null, content_type: "observation",
      chunk_text: "a", embedding: vec(1), tags: ["discord-live"] });
    store.insert({ vault_path: "other/m2.md", companion: null, content_type: "observation",
      chunk_text: "b", embedding: vec(0), tags: [] });
    // identical vector under the prefix -> sim ~1
    expect(store.maxSimilarityForPrefix(vec(1), "discord-live/chan1/", 2)).toBeGreaterThan(0.99);
    // orthogonal vector -> low sim (the other/ row must NOT count)
    expect(store.maxSimilarityForPrefix(vec(0), "discord-live/chan1/", 2)).toBeLessThan(0.1);
  });

  it("returns 0 when no rows match the prefix", () => {
    const store = makeStore();
    expect(store.maxSimilarityForPrefix(vec(1), "discord-live/none/", 2)).toBe(0);
  });

  it("returns 0 for an empty query embedding", () => {
    const store = makeStore();
    expect(store.maxSimilarityForPrefix([], "discord-live/", 2)).toBe(0);
  });
});

describe("evaluateSurprisal", () => {
  it("gates above threshold, stores below", () => {
    resetSurprisalState();
    expect(evaluateSurprisal("chan1", 0.95, { base: 0.90, floor: 0.78, step: 0.03 }).gated).toBe(true);
    resetSurprisalState();
    expect(evaluateSurprisal("chan1", 0.50, { base: 0.90, floor: 0.78, step: 0.03 }).gated).toBe(false);
  });

  it("lowers the effective threshold after consecutive gates (adaptive), resets on store", () => {
    resetSurprisalState();
    const cfg = { base: 0.90, floor: 0.78, step: 0.03 };
    evaluateSurprisal("chan2", 0.95, cfg); // gated, consecutive=1
    evaluateSurprisal("chan2", 0.95, cfg); // gated, consecutive=2
    const third = evaluateSurprisal("chan2", 0.85, cfg); // threshold now 0.90-0.06=0.84 -> 0.85 gated
    expect(third.gated).toBe(true);
    const fourth = evaluateSurprisal("chan2", 0.80, cfg); // threshold 0.81 -> stored, resets
    expect(fourth.gated).toBe(false);
    // back at base after a store
    expect(evaluateSurprisal("chan2", 0.85, cfg).gated).toBe(false);
  });

  it("never drops below the floor", () => {
    resetSurprisalState();
    const cfg = { base: 0.90, floor: 0.86, step: 0.03 };
    for (let i = 0; i < 10; i++) evaluateSurprisal("chan3", 0.99, cfg);
    expect(evaluateSurprisal("chan3", 0.861, cfg).gated).toBe(true); // floor holds at 0.86
  });

  it("tracks channels independently", () => {
    resetSurprisalState();
    const cfg = { base: 0.90, floor: 0.78, step: 0.03 };
    evaluateSurprisal("chanA", 0.95, cfg); // chanA consecutive=1
    // chanB still at base threshold 0.90
    expect(evaluateSurprisal("chanB", 0.88, cfg).gated).toBe(false);
  });
});
