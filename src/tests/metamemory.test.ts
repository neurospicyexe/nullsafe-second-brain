// Metamemory feedback loop (0070): sb_feedback increments usefulness counters and
// a Laplace-smoothed reliability term nudges hybrid ranking. Convergent design from
// Zikkaron rate_memory + CogCor update_memory_outcome.

import { describe, it, expect } from "vitest";
import { VectorStore } from "../store/vector-store.js";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

function makeStore() {
  const dbPath = join(tmpdir(), `vs-meta-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new VectorStore(dbPath);
  store.initialize();
  return { store, dbPath };
}

const EMB = Array.from({ length: 8 }, (_, i) => i * 0.1);

function makeChunk(path: string) {
  return {
    vault_path: path,
    companion: "cypher",
    content_type: "note",
    chunk_text: "identical chunk text about thresholds",
    prefixed_text: `${path} | companion:cypher | note:\nidentical chunk text about thresholds`,
    section: "S",
    chunk_index: 0,
    embedding: EMB,
    tags: [],
  };
}

describe("metamemory feedback", () => {
  it("has the usefulness columns after initialize", () => {
    const { store, dbPath } = makeStore();
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const names = (db.prepare("PRAGMA table_info(embeddings)").all() as { name: string }[]).map(c => c.name);
    expect(names).toContain("useful_count");
    expect(names).toContain("useless_count");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("recordFeedback increments counters and skips unknown ids", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk("a.md"));
    const [hit] = store.hybridSearch(EMB, "thresholds", 5);
    expect(hit).toBeDefined();

    expect(store.recordFeedback([hit!.id, "not-a-real-id"], true)).toBe(1);
    expect(store.recordFeedback([hit!.id], false)).toBe(1);

    const [after] = store.hybridSearch(EMB, "thresholds", 5);
    expect(after!.useful_count).toBe(1);
    expect(after!.useless_count).toBe(1);
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("useful chunks outrank identical fresh chunks; useless chunks sink", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk("useful.md"));
    store.insert(makeChunk("fresh.md"));
    store.insert(makeChunk("useless.md"));

    const initial = store.hybridSearch(EMB, "thresholds", 5);
    const useful = initial.find(c => c.vault_path === "useful.md")!;
    const useless = initial.find(c => c.vault_path === "useless.md")!;

    store.recordFeedback([useful.id], true);
    store.recordFeedback([useless.id], false);

    const ranked = store.hybridSearch(EMB, "thresholds", 5);
    expect(ranked[0]!.vault_path).toBe("useful.md");
    expect(ranked[ranked.length - 1]!.vault_path).toBe("useless.md");
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("fresh chunks (0/0) get exactly zero metamemory boost (reliability 0.5)", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk("a.md"));
    store.insert(makeChunk("b.md"));
    const [first, second] = store.hybridSearch(EMB, "thresholds", 5);
    expect(first!.score).toBeCloseTo(second!.score, 10);
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("boost is capped at +/-0.05 even with heavy feedback", () => {
    const { store, dbPath } = makeStore();
    store.insert(makeChunk("hot.md"));
    store.insert(makeChunk("cold.md"));
    const initial = store.hybridSearch(EMB, "thresholds", 5);
    const hot = initial.find(c => c.vault_path === "hot.md")!;
    const cold = initial.find(c => c.vault_path === "cold.md")!;
    for (let i = 0; i < 30; i++) {
      store.recordFeedback([hot.id], true);
      store.recordFeedback([cold.id], false);
    }
    const ranked = store.hybridSearch(EMB, "thresholds", 5);
    const hotAfter = ranked.find(c => c.vault_path === "hot.md")!;
    const coldAfter = ranked.find(c => c.vault_path === "cold.md")!;
    expect(hotAfter.score - coldAfter.score).toBeLessThanOrEqual(0.1 + 1e-9);
    store.close();
    rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });
});
