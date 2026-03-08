import { describe, it, expect, beforeEach } from "vitest";
import { VectorStore } from "../../src/store/vector-store.js";

describe("VectorStore", () => {
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore(":memory:");
    store.initialize();
  });

  it("inserts a chunk and retrieves it by id", () => {
    const id = store.insert({
      vault_path: "05 - GALAXY/test-note.md",
      companion: null,
      content_type: "note",
      chunk_text: "This is a test chunk",
      embedding: [0.1, 0.2, 0.3],
      tags: ["test"],
    });
    const row = store.getById(id);
    expect(row?.chunk_text).toBe("This is a test chunk");
    expect(row?.companion).toBeNull();
    expect(row?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(row?.tags).toEqual(["test"]);
  });

  it("filters by companion", () => {
    store.insert({ vault_path: "a.md", companion: "companion-a", content_type: "document", chunk_text: "A doc", embedding: [0.1], tags: [] });
    store.insert({ vault_path: "b.md", companion: null, content_type: "note", chunk_text: "Human note", embedding: [0.2], tags: [] });
    const results = store.filterByCompanion("companion-a");
    expect(results).toHaveLength(1);
    expect(results[0].chunk_text).toBe("A doc");
  });

  it("filterByCompanion null returns only null-companion rows", () => {
    store.insert({ vault_path: "a.md", companion: "companion-a", content_type: "document", chunk_text: "A doc", embedding: [0.1], tags: [] });
    store.insert({ vault_path: "b.md", companion: null, content_type: "note", chunk_text: "Human note", embedding: [0.2], tags: [] });
    const results = store.filterByCompanion(null);
    expect(results).toHaveLength(1);
    expect(results[0].chunk_text).toBe("Human note");
  });

  it("deletes chunks by vault path", () => {
    store.insert({ vault_path: "delete-me.md", companion: null, content_type: "note", chunk_text: "gone", embedding: [0.1], tags: [] });
    store.deleteByPath("delete-me.md");
    expect(store.getAll().find(r => r.vault_path === "delete-me.md")).toBeUndefined();
  });

  it("getAll returns all rows", () => {
    store.insert({ vault_path: "x.md", companion: null, content_type: "note", chunk_text: "x", embedding: [0.1], tags: [] });
    store.insert({ vault_path: "y.md", companion: null, content_type: "note", chunk_text: "y", embedding: [0.2], tags: [] });
    expect(store.getAll()).toHaveLength(2);
  });

  it("generated ids are unique", () => {
    const id1 = store.insert({ vault_path: "a.md", companion: null, content_type: "note", chunk_text: "a", embedding: [], tags: [] });
    const id2 = store.insert({ vault_path: "b.md", companion: null, content_type: "note", chunk_text: "b", embedding: [], tags: [] });
    expect(id1).not.toBe(id2);
  });
});
