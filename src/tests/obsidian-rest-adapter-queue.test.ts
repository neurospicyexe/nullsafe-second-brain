import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ObsidianRestAdapter } from "../adapters/obsidian-rest-adapter.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let queueDir: string;
let adapter: ObsidianRestAdapter;

beforeEach(() => {
  mockFetch.mockReset();
  queueDir = mkdtempSync(join(tmpdir(), "sb-obsidian-queue-test-"));
  adapter = new ObsidianRestAdapter({
    url: "https://obsidian.example.com",
    apiKey: "test-key",
    queuePath: join(queueDir, "vault-queue.db"),
  });
});

afterEach(() => {
  adapter.close();
  rmSync(queueDir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = (a: ObsidianRestAdapter) => a as any;
const ok = { ok: true, status: 204, statusText: "No Content" };
const bad = { ok: false, status: 502, statusText: "Bad Gateway" };

/** A fetch response the test releases by hand, to hold a retry PUT in flight. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<typeof ok>(resolve => { release = () => resolve(ok); });
  return { promise, release };
}

/** Queue a failed write and make it immediately due. Consumes one fetch call. */
async function queueOne(path: string, content: string) {
  mockFetch.mockResolvedValueOnce(bad);
  await adapter.write({ path, content });
  internals(adapter).queue.prepare("UPDATE pending_writes SET next_retry_at = 0").run();
}

describe("ObsidianRestAdapter retry vs direct write/delete (S-1)", () => {
  it("A: a newer write that fails during an in-flight retry is not deleted by that retry", async () => {
    await queueOne("n/a.md", "v1");
    const gate = deferred();
    mockFetch.mockReturnValueOnce(gate.promise); // retry PUT of v1, held open
    const retry = internals(adapter).processQueue();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    mockFetch.mockResolvedValueOnce(bad); // direct write of v2 fails too
    const direct = adapter.write({ path: "n/a.md", content: "v2" });
    gate.release();
    await retry;
    expect((await direct).delivered).toBe(false);
    const rows = internals(adapter).queue.prepare("SELECT content FROM pending_writes").all();
    expect(rows).toEqual([{ content: "v2" }]);
  });

  it("B: a stale retry PUT cannot land after a newer direct write", async () => {
    await queueOne("n/b.md", "v1");
    const gate = deferred();
    mockFetch.mockReturnValueOnce(gate.promise);
    const retry = internals(adapter).processQueue();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    mockFetch.mockResolvedValueOnce(ok);
    const direct = adapter.write({ path: "n/b.md", content: "v2" });
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(2); // direct write is waiting its turn
    gate.release();
    await Promise.all([retry, direct]);
    const bodies = mockFetch.mock.calls.filter(c => c[1]?.method === "PUT").map(c => c[1].body);
    expect(bodies).toEqual(["v1", "v1", "v2"]); // first v1 = the original failed attempt; v2 lands last
    expect(adapter.pendingCount()).toBe(0);
  });

  it("delete cannot be resurrected by an in-flight retry", async () => {
    await queueOne("n/c.md", "v1");
    const gate = deferred();
    mockFetch.mockReturnValueOnce(gate.promise);
    const retry = internals(adapter).processQueue();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const del = adapter.delete("n/c.md");
    gate.release();
    await Promise.all([retry, del]);
    const methods = mockFetch.mock.calls.slice(1).map(c => c[1]?.method);
    expect(methods).toEqual(["PUT", "DELETE"]); // DELETE strictly after the retry PUT
    expect(adapter.pendingCount()).toBe(0);
  });

  it("skips a row that vanished before its turn", async () => {
    await queueOne("n/d.md", "v1");
    internals(adapter).queue.prepare("DELETE FROM pending_writes").run();
    await internals(adapter).retryRow(1);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the original failed write
  });

  it("hasPending reflects the queue", async () => {
    expect(adapter.hasPending("n/e.md")).toBe(false);
    mockFetch.mockResolvedValueOnce(bad);
    await adapter.write({ path: "n/e.md", content: "x" });
    expect(adapter.hasPending("n/e.md")).toBe(true);
  });
});

describe("ObsidianRestAdapter.move with a queued destination (S-3)", () => {
  it("keeps the source and throws when the destination write was only queued", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "body" }); // read source
    mockFetch.mockResolvedValueOnce(bad); // dest PUT fails
    await expect(adapter.move("src.md", "dst.md")).rejects.toThrow("source kept");
    expect(mockFetch.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(false);
    expect(adapter.hasPending("dst.md")).toBe(true);
  });

  it("deletes the source once the destination is delivered", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "body" });
    mockFetch.mockResolvedValueOnce(ok);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    await adapter.move("src.md", "dst.md");
    expect(mockFetch.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });
});

describe("ObsidianRestAdapter processQueue re-entrancy (S-4)", () => {
  it("a second tick during a slow first tick does nothing, and the guard releases", async () => {
    await queueOne("n/f.md", "v1");
    const gate = deferred();
    mockFetch.mockReturnValueOnce(gate.promise);
    const first = internals(adapter).processQueue();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await internals(adapter).processQueue();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    gate.release();
    await first;
    expect(adapter.pendingCount()).toBe(0);

    await queueOne("n/g.md", "v1");
    mockFetch.mockResolvedValueOnce(ok);
    await internals(adapter).processQueue();
    expect(adapter.pendingCount()).toBe(0);
  });
});
