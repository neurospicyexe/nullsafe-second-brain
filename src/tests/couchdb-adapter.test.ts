import { describe, it, expect, vi, beforeEach } from "vitest";
import { CouchDBAdapter } from "../adapters/couchdb-adapter.js";

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
    expect(metaBody.deleted).toBe(false);
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
  it("reads and decodes base64 chunk content", async () => {
    const content = "hello world";
    const b64 = Buffer.from(content).toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "test.md", children: ["h:abc123"], deleted: false }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "h:abc123", data: b64, type: "leaf" }),
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
  it("excludes chunk docs, version doc, and deleted files", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          { id: "h:abc", doc: { type: "leaf", deleted: false } },
          { id: "obsydian_livesync_version", doc: { type: "versioninfo" } },
          { id: "companions/drevan/note.md", doc: { type: "plain", deleted: false } },
          { id: "raziel/daily/old.md", doc: { type: "plain", deleted: true } },
          { id: "companions/cypher/audit.md", doc: { type: "plain", deleted: false } },
        ],
      }),
    });

    const result = await adapter.list();
    expect(result).toEqual(["companions/drevan/note.md", "companions/cypher/audit.md"]);
  });

  it("filters by directory prefix", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          { id: "companions/drevan/note.md", doc: { type: "plain", deleted: false } },
          { id: "raziel/daily/log.md", doc: { type: "plain", deleted: false } },
        ],
      }),
    });

    const result = await adapter.list("companions");
    expect(result).toEqual(["companions/drevan/note.md"]);
  });
});
