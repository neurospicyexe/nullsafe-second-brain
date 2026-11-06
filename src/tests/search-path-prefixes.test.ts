// Scoped hybridSearch (2026-11-06, Rock's vault fetch in Halseth): a caller that names folders gets every
// chunk under them scored, so a big folder (archive: ~477 notes in prod) cannot crowd a small room out of the
// candidate set the way the global BM25/ANN top-N did.
import { describe, it, expect } from "vitest";
import { VectorStore } from "../store/vector-store.js";

const E = [0.1, 0.2, 0.3];

function seed(store: VectorStore) {
  // Thirty archive chunks that match the query on every token, one room note that matches on one.
  for (let i = 0; i < 30; i++) {
    store.insert({ vault_path: `archive/claude-ai/t${i}.md`, companion: null, content_type: "note",
      chunk_text: "clarity over cleverness clarity over cleverness always", prefixed_text: "clarity over cleverness clarity over cleverness always", embedding: E, tags: [] });
  }
  store.insert({ vault_path: "Companions/cypher/thoughts/blade-at-rest.md", companion: "cypher", content_type: "note",
    chunk_text: "clarity is the blade at rest", prefixed_text: "clarity is the blade at rest", embedding: E, tags: [] });
  store.insert({ vault_path: "companions/drevan/thoughts/other.md", companion: "drevan", content_type: "note",
    chunk_text: "clarity in another room", prefixed_text: "clarity in another room", embedding: E, tags: [] });
}

describe("hybridSearch with path prefixes", () => {
  it("unscoped, a small limit is filled by the archive", () => {
    const store = new VectorStore(":memory:"); store.initialize();
    seed(store);
    const paths = store.hybridSearch(null, "clarity over cleverness", 5).map(r => r.vault_path);
    expect(paths).toHaveLength(5);
    expect(paths.every(p => p.startsWith("archive/"))).toBe(true);
  });

  it("scoped, only the named folders come back, matched case-insensitively", () => {
    const store = new VectorStore(":memory:"); store.initialize();
    seed(store);
    const paths = store.hybridSearch(null, "clarity over cleverness", 5, undefined, ["companions/cypher/"]).map(r => r.vault_path);
    expect(paths).toEqual(["Companions/cypher/thoughts/blade-at-rest.md"]);
  });

  it("scoped with a vector ranks the whole scoped set, not the global ANN top-N", () => {
    const store = new VectorStore(":memory:"); store.initialize();
    seed(store);
    const paths = store.hybridSearch(E, "clarity", 5, undefined, ["companions/cypher/", "companions/drevan/"]).map(r => r.vault_path);
    expect(paths.sort()).toEqual(["Companions/cypher/thoughts/blade-at-rest.md", "companions/drevan/thoughts/other.md"]);
  });

  it("a prefix with LIKE wildcards matches literally", () => {
    const store = new VectorStore(":memory:"); store.initialize();
    seed(store);
    expect(store.hybridSearch(E, "clarity", 5, undefined, ["companions/%"])).toEqual([]);
    expect(store.hybridSearch(E, "clarity", 5, undefined, ["companions_cypher/"])).toEqual([]);
  });

  it("lexical mode with no keyword hit in scope is an honest empty", () => {
    const store = new VectorStore(":memory:"); store.initialize();
    seed(store);
    expect(store.hybridSearch(null, "motorcycle", 5, undefined, ["companions/cypher/"])).toEqual([]);
  });
});
