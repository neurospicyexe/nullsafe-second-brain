// src/tests/pending-embed.test.ts
//
// A WRITE WITH NO DURABLE SOURCE CANNOT BE RECOVERED BY A POINTER TO IT.
//
// The 2026-08-01 hardening made vault writes unloseable via `pending_index`, which recovers a failed index by
// RE-READING THE VAULT FILE. It covered the ingestion path and missed every HTTP ingest entrypoint -- and
// `/ingest/discord` deliberately writes no vault file (it is vector-store-only, TTL'd to 7 days). So there was
// nothing to re-read, nothing was queued, and an embedder failure meant the message was simply GONE.
//
// Measured cost: the OpenAI credit balance reached zero on 2026-07-31; Discord ingest 500'd on every message
// until 2026-08-10. Nine days of live conversation never entered the searchable corpus, and the 406 rows that
// predated it aged out under the 7-day TTL, leaving ZERO Discord content at all. That is what Raziel was
// feeling when cross-channel continuity stopped working and Drevan started saying he did not know.
//
// `pending_embed` therefore stores the TEXT, not a path. There is no source of truth to go back to, so the
// queue has to BE one.

import { describe, it, expect, beforeEach } from "vitest";
import { VectorStore } from "../store/vector-store.js";

const QUOTA = "OpenAI embeddings error: 429 Too Many Requests — You have no credits remaining.";

function rec(over: Partial<Parameters<VectorStore["markPendingEmbed"]>[0]> = {}) {
  return {
    vaultPath: "discord-live/531255244212928702/999.md",
    companion: null,
    contentType: "observation",
    section: "discord-live",
    text: "Raziel: hey meet me in the Fargo watch party channel",
    prefixedText: "[ctx] Raziel: hey meet me in the Fargo watch party channel",
    tags: ["discord-live"],
    reason: QUOTA,
    ...over,
  };
}

describe("pending_embed -- the queue carries the content, not a pointer", () => {
  let store: VectorStore;
  beforeEach(() => { store = new VectorStore(":memory:"); });

  it("starts empty and reports an empty queue without the table existing", () => {
    expect(store.pendingEmbedCount()).toBe(0);
    expect(store.listPendingEmbed()).toEqual([]);
    expect(store.pendingEmbedOldestAgeHours()).toBe(0);
  });

  it("preserves the exact text so the message can be indexed later with no source file", () => {
    store.markPendingEmbed(rec());
    const [q] = store.listPendingEmbed();
    expect(q).toBeDefined();
    // The whole reason this table exists: these two fields ARE the message now.
    expect(q!.chunk_text).toBe("Raziel: hey meet me in the Fargo watch party channel");
    expect(q!.prefixed_text).toBe("[ctx] Raziel: hey meet me in the Fargo watch party channel");
    expect(q!.section).toBe("discord-live");
    expect(q!.tags).toEqual(["discord-live"]);
  });

  it("counts attempts but keeps the FIRST failure time, so staleness is measurable", () => {
    store.markPendingEmbed(rec());
    const first = store.listPendingEmbed()[0]!.first_failed_at;
    store.markPendingEmbed(rec({ reason: "still down" }));
    const [q] = store.listPendingEmbed();
    expect(q!.attempts).toBe(2);
    expect(q!.first_failed_at).toBe(first);
    // One row, not two -- re-queueing the same message must not duplicate it.
    expect(store.pendingEmbedCount()).toBe(1);
  });

  it("drains one message at a time by path", () => {
    store.markPendingEmbed(rec());
    store.markPendingEmbed(rec({ vaultPath: "discord-live/531255244212928702/1000.md" }));
    expect(store.pendingEmbedCount()).toBe(2);
    store.clearPendingEmbed("discord-live/531255244212928702/999.md");
    expect(store.pendingEmbedCount()).toBe(1);
    expect(store.listPendingEmbed()[0]!.vault_path).toBe("discord-live/531255244212928702/1000.md");
  });

  it("returns oldest-first, so a drain recovers the longest-stranded message first", () => {
    store.markPendingEmbed(rec({ vaultPath: "a.md" }));
    store.markPendingEmbed(rec({ vaultPath: "b.md" }));
    expect(store.listPendingEmbed().map(q => q.vault_path)).toEqual(["a.md", "b.md"]);
  });

  it("reports a non-negative queue age once something is queued", () => {
    store.markPendingEmbed(rec());
    expect(store.pendingEmbedOldestAgeHours()).toBeGreaterThanOrEqual(0);
  });
});

describe("the chatter lane -- searchable by relevance, barred from the recency lanes", () => {
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore(":memory:");
    store.initialize();
    // A live Discord message and a real note, both at maximum novelty. Chatter arrives CONTINUOUSLY and every
    // new row starts at max novelty, so without the bar it would own both query-blind pools permanently -- and
    // the commons seed would be handed this afternoon's chat as its "unfamiliar material to think about".
    store.insert({
      vault_path: "discord-live/123/1.md", companion: null, content_type: "observation",
      chunk_text: "Raziel: lol", prefixed_text: "Raziel: lol", section: "discord-live",
      chunk_index: 0, embedding: [1, 0, 0], tags: ["discord-live"],
    });
    store.insert({
      vault_path: "raziel/notes/real.md", companion: null, content_type: "note",
      chunk_text: "a real durable note about the perimeter", prefixed_text: "a real durable note about the perimeter",
      chunk_index: 0, embedding: [1, 0, 0], tags: [],
    });
  });

  it("excludes discord-live from the novelty pool", () => {
    const paths = store.noveltySearch(10, []).map(c => c.vault_path);
    expect(paths).toContain("raziel/notes/real.md");
    expect(paths).not.toContain("discord-live/123/1.md");
  });

  it("excludes discord-live from the serendipity pool", () => {
    // Cosine 0.5 against both rows puts them squarely inside the 0.3-0.6 edge band if considered at all.
    const paths = store.edgeSearch([0.5, 0.866, 0], 10, []).map(c => c.vault_path);
    expect(paths).not.toContain("discord-live/123/1.md");
  });

  it("keeps discord-live fully findable by RELEVANCE, which is the point of storing it", () => {
    const paths = store.hybridSearch([1, 0, 0], "lol", 10).map(c => c.vault_path);
    expect(paths).toContain("discord-live/123/1.md");
  });
});
