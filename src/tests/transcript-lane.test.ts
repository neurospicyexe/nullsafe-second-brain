// Export transcripts (Claude.ai / ChatGPT) are searchable by meaning, dated by the CONVERSATION, and barred
// from the query-blind novelty pools. 2026-10-12: all three were false on the live store (created_at was the
// ingest day; every one of ~48k chunks had been surfaced through pools 2/3).

import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { VectorStore } from "../store/vector-store.js";
import { transcriptCreatedAt } from "../store/transcript-date.js";

function makeStore() {
  const dbPath = join(tmpdir(), `vs-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new VectorStore(dbPath);
  store.initialize();
  return { store, dbPath };
}

function chunk(vault_path: string, tags: string[], over: Record<string, unknown> = {}) {
  return {
    vault_path, companion: null, content_type: "document",
    chunk_text: "ankle fall doctor", prefixed_text: "ankle fall doctor", section: "Heading", chunk_index: 0,
    embedding: Array.from({ length: 8 }, (_, i) => (i + 1) * 0.1), tags, ...over,
  };
}

describe("transcriptCreatedAt", () => {
  it("reads the conversation date from all three export directories", () => {
    expect(transcriptCreatedAt("archive/claude-ai/2025-09-12-660fe411.md")).toBe("2025-09-12 00:00:00");
    expect(transcriptCreatedAt("archive/claude-ai/2026-02-22-531e9071.part3.md")).toBe("2026-02-22 00:00:00");
    expect(transcriptCreatedAt("companions/drevan/claude-ai/2026-02-14-0bd1e6bc.md")).toBe("2026-02-14 00:00:00");
    expect(transcriptCreatedAt("companions/triad/chatgpt/2025-07-03-68668783.part1.md")).toBe("2025-07-03 00:00:00");
  });
  it("leaves every other path alone, and rejects impossible dates", () => {
    expect(transcriptCreatedAt("rag/companion_journal/abc")).toBeNull();
    expect(transcriptCreatedAt("companions/drevan/notes/2026-02-14-x.md")).toBeNull();
    expect(transcriptCreatedAt("archive/claude-ai/2025-02-31-aaaa.md")).toBeNull();
    expect(transcriptCreatedAt("archive/claude-ai/notes.md")).toBeNull();
  });
});

describe("VectorStore transcript lane", () => {
  it("dates a new transcript chunk by the conversation, other chunks by now", () => {
    const { store, dbPath } = makeStore();
    const t = store.insert(chunk("archive/claude-ai/2025-09-12-660fe411.md", ["chatter", "claude_ai_transcript"]));
    const n = store.insert(chunk("rag/open_loop/x", []));
    expect(store.getById(t)!.created_at).toBe("2025-09-12 00:00:00");
    expect(store.getById(n)!.created_at.slice(0, 4)).toBe(String(new Date().getUTCFullYear()));
    store.close(); rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("backfills rows indexed with the ingest date, once", () => {
    const { store, dbPath } = makeStore();
    const id = store.insert(chunk("companions/triad/chatgpt/2025-07-11-6870635c.md", ["chatter", "chatgpt_transcript"]));
    const db = (store as any).db;
    db.prepare("UPDATE embeddings SET created_at = '2026-09-06 21:17:00' WHERE id = ?").run(id);
    expect(store.backfillTranscriptDates()).toBe(1);
    expect(store.getById(id)!.created_at).toBe("2025-07-11 00:00:00");
    expect(store.backfillTranscriptDates()).toBe(0);
    store.close(); rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });

  it("bars chatter-tagged chunks from the novelty pools but not from relevance search", () => {
    const { store, dbPath } = makeStore();
    store.insert(chunk("archive/claude-ai/2025-09-12-660fe411.md", ["chatter", "claude_ai_transcript"]));
    store.insert(chunk("rag/open_loop/x", ["loop"]));
    const q = Array.from({ length: 8 }, (_, i) => (i + 1) * 0.1);
    expect(store.noveltySearch(10, []).map(c => c.vault_path)).toEqual(["rag/open_loop/x"]);
    expect(store.edgeSearch(q, 10, []).every(c => c.vault_path !== "archive/claude-ai/2025-09-12-660fe411.md")).toBe(true);
    const hits = store.hybridSearch(q, "ankle", 10).map(c => c.vault_path);
    expect(hits).toContain("archive/claude-ai/2025-09-12-660fe411.md");
    store.close(); rmSync(dbPath, { maxRetries: 5, retryDelay: 100 });
  });
});
