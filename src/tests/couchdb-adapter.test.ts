import { describe, it, expect, vi, beforeEach } from "vitest";
import { CouchDBAdapter, livesyncDocId } from "../adapters/couchdb-adapter.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const adapter = new CouchDBAdapter({
  url: "http://localhost:5984",
  db: "test-vault",
  username: "admin",
  password: "pass",
});

beforeEach(() => { mockFetch.mockReset(); });

describe("CouchDBAdapter.exists", () => {
  it("returns true when metadata doc exists and is not deleted", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ _id: "foo.md", deleted: false, children: [] }),
    });
    expect(await adapter.exists("foo.md")).toBe(true);
  });

  it("returns false when doc has deleted: true", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ _id: "foo.md", deleted: true, children: [] }),
    });
    expect(await adapter.exists("foo.md")).toBe(false);
  });

  it("returns false when doc not found (404)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await adapter.exists("foo.md")).toBe(false);
  });
});

describe("CouchDBAdapter path traversal", () => {
  it("write rejects a path with .. segments", async () => {
    await expect(adapter.write({ path: "../../outside/note.md", content: "x" }))
      .rejects.toThrow("resolves outside vault root");
  });

  it("read rejects a path with .. segments", async () => {
    await expect(adapter.read("../../outside/note.md")).rejects.toThrow("resolves outside vault root");
  });

  it("exists rejects a path with .. segments", async () => {
    await expect(adapter.exists("../../outside/note.md")).rejects.toThrow("resolves outside vault root");
  });

  it("move rejects when either side has .. segments", async () => {
    await expect(adapter.move("../../outside.md", "safe.md")).rejects.toThrow("resolves outside vault root");
    await expect(adapter.move("safe.md", "../../outside.md")).rejects.toThrow("resolves outside vault root");
  });

  it("delete rejects a path with .. segments", async () => {
    await expect(adapter.delete("../../outside/note.md")).rejects.toThrow("resolves outside vault root");
  });

  it("list rejects a path with .. segments", async () => {
    // CouchDB's list() filter (r.id.startsWith(prefix)) isn't exploitable today since a
    // ".."-prefixed query just matches nothing, but the guard module's docstring claims
    // parity with FilesystemAdapter.safePath (which guards its list-equivalent), so this
    // adapter gets it too for consistency and defense-in-depth.
    await expect(adapter.list("../../outside")).rejects.toThrow("resolves outside vault root");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("CouchDBAdapter.write", () => {
  it("PUTs a chunk doc and metadata doc", async () => {
    // chunk PUT
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, rev: "1-abc" }) });
    // metadata GET (no existing doc)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    // metadata PUT
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await adapter.write({ path: "test.md", content: "hello" });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const metaPutCall = mockFetch.mock.calls[2];
    const metaBody = JSON.parse(metaPutCall[1].body);
    expect(metaBody.path).toBe("test.md");
    expect(metaBody.children).toHaveLength(1);
    expect(metaBody.deleted).toBeUndefined(); // not set for new docs; only set to false on update
  });

  it("preserves ctime and passes _rev when updating existing doc", async () => {
    // chunk PUT
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    // metadata GET (existing doc)
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ _id: "test.md", _rev: "2-xyz", ctime: 9999, children: ["h:old"], deleted: false }),
    });
    // metadata PUT
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await adapter.write({ path: "test.md", content: "updated" });

    const metaBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(metaBody._rev).toBe("2-xyz");
    expect(metaBody.ctime).toBe(9999);
  });

  it("skips write when overwrite is false and doc exists", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ _id: "test.md", deleted: false, children: [] }),
    });

    await adapter.write({ path: "test.md", content: "hello", overwrite: false });

    expect(mockFetch).toHaveBeenCalledTimes(1); // only the exists check
  });
});

describe("CouchDBAdapter.read", () => {
  it("reads UTF-8 chunk content", async () => {
    const content = "hello world";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "test.md", children: ["h:abc123"], deleted: false }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "h:abc123", data: content, type: "leaf" }),
    });

    const result = await adapter.read("test.md");
    expect(result).toBe(content);
  });

  it("throws when file not found", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(adapter.read("missing.md")).rejects.toThrow("File not found");
  });
});

describe("CouchDBAdapter.list", () => {
  it("root listing uses _find and drops deleted docs, returning original-case paths", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        docs: [
          { _id: "companions/drevan/note.md", path: "Companions/drevan/note.md", type: "plain" },
          { _id: "raziel/daily/old.md", path: "raziel/daily/old.md", type: "plain", deleted: true },
          { _id: "companions/cypher/audit.md", path: "Companions/cypher/audit.md", type: "plain" },
        ],
      }),
    });

    const result = await adapter.list();
    expect(result).toEqual(["Companions/drevan/note.md", "Companions/cypher/audit.md"]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:5984/test-vault/_find");
    expect(JSON.parse(init.body).selector.type.$in).toEqual(["plain", "newnote"]);
  });

  it("a folder listing is a lowercase key-range read that never touches chunks", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          { id: "companions/drevan/note.md", doc: { _id: "companions/drevan/note.md", path: "Companions/drevan/note.md", type: "plain" } },
        ],
      }),
    });

    const result = await adapter.list("Companions");
    expect(result).toEqual(["Companions/drevan/note.md"]);
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/test-vault/_all_docs");
    expect(JSON.parse(url.searchParams.get("startkey")!)).toBe("companions/");
    expect(JSON.parse(url.searchParams.get("endkey")!)).toBe("companions/￰");
  });

  it("accepts an empty string explicitly (vault root)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ docs: [] }) });
    await expect(adapter.list("")).resolves.toEqual([]);
  });

  it("listChildren returns one level in Obsidian REST shape", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          { id: "raziel/a.md", doc: { _id: "raziel/a.md", path: "raziel/a.md", type: "plain" } },
          { id: "raziel/sessions/x.md", doc: { _id: "raziel/sessions/x.md", path: "raziel/sessions/x.md", type: "plain" } },
          { id: "raziel/sessions/y.md", doc: { _id: "raziel/sessions/y.md", path: "raziel/sessions/y.md", type: "plain" } },
        ],
      }),
    });
    await expect(adapter.listChildren("raziel")).resolves.toEqual(["raziel/a.md", "raziel/sessions/"]);
  });
});

describe("LiveSync document ids", () => {
  it("lowercases, and prefixes '/' for a leading underscore", () => {
    expect(livesyncDocId("Companions/Drevan/Note.md")).toBe("companions/drevan/note.md");
    expect(livesyncDocId("_archive/2026-11-01/X.md")).toBe("/_archive/2026-11-01/x.md");
    expect(livesyncDocId("raziel/_inner.md")).toBe("raziel/_inner.md");
  });

  it("read looks the note up by its LiveSync id", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ _id: "/_archive/x.md", path: "_archive/X.md", type: "plain", children: ["h:1"] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ _id: "h:1", data: "hello" }) });
    await expect(adapter.read("_archive/X.md")).resolves.toBe("hello");
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:5984/test-vault/" + encodeURIComponent("/_archive/x.md"));
  });

  it("falls back to the raw path for docs the legacy write() created", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ _id: "Legacy/N.md", path: "Legacy/N.md", type: "plain", children: ["h:2"] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ _id: "h:2", data: "old" }) });
    await expect(adapter.read("Legacy/N.md")).resolves.toBe("old");
  });

  it("uses inline eden chunks and decodes newnote base64", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        _id: "b.md", path: "b.md", type: "newnote", children: ["h:e"],
        eden: { "h:e": { data: Buffer.from("café", "utf-8").toString("base64") } },
      }),
    });
    await expect(adapter.read("b.md")).resolves.toBe("café");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("treats _deleted and non-note docs as absent", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ _id: "x.md", _deleted: true, type: "plain" }) });
    expect(await adapter.exists("x.md")).toBe(false);
  });
});
