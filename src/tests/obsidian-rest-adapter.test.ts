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
  queueDir = mkdtempSync(join(tmpdir(), "sb-obsidian-test-"));
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

describe("ObsidianRestAdapter path traversal", () => {
  it("read rejects a path with .. segments", async () => {
    await expect(adapter.read("../../outside/note.md")).rejects.toThrow("resolves outside vault root");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("exists rejects a path with .. segments", async () => {
    await expect(adapter.exists("../../outside/note.md")).rejects.toThrow("resolves outside vault root");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("delete rejects a path with .. segments", async () => {
    await expect(adapter.delete("../../outside/note.md")).rejects.toThrow("resolves outside vault root");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("move rejects when the destination has .. segments", async () => {
    await expect(adapter.move("safe.md", "../../outside.md")).rejects.toThrow("resolves outside vault root");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("write queues nothing and throws synchronously for a .. path", async () => {
    // write() catches its own errors and queues for retry (line 61-68) -- traversal
    // must be checked BEFORE that try/catch, or a malicious path silently retries forever.
    await expect(adapter.write({ path: "../../outside/note.md", content: "x" }))
      .rejects.toThrow("resolves outside vault root");
    expect(adapter.pendingCount()).toBe(0);
  });

  it("list rejects a path with .. segments", async () => {
    // list() is LLM-reachable via tools/system.ts (adapter.list(args.path ?? "")) and,
    // for this adapter, exploitable: encodeVaultPath only encodes per-segment so a
    // literal ".." segment survives to the URL and gets resolved upward by fetch.
    await expect(adapter.list("../../outside")).rejects.toThrow("resolves outside vault root");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("ObsidianRestAdapter.write result", () => {
  it("returns { delivered: true } and leaves the queue empty when the PUT succeeds", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
    const result = await adapter.write({ path: "notes/ok.md", content: "hello" });
    expect(result).toEqual({ delivered: true });
    expect(adapter.pendingCount()).toBe(0);
  });

  it("returns { delivered: false, queued: true } and queues the write when the PUT fails", async () => {
    // Before this result existed, write() returned void here and the materializer counted the row as
    // written and PATCHed vault_path on Halseth for a file that never landed.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, statusText: "Bad Gateway" });
    const result = await adapter.write({ path: "notes/down.md", content: "hello" });
    expect(result).toEqual({ delivered: false, queued: true });
    expect(adapter.pendingCount()).toBe(1);
  });

  it("queues on a network error too (fetch rejects), not only on a non-2xx", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await adapter.write({ path: "notes/net.md", content: "hello" });
    expect(result.delivered).toBe(false);
    expect(adapter.pendingCount()).toBe(1);
  });

  it("a later successful write for the same path clears its queue entry", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, statusText: "Bad Gateway" });
    await adapter.write({ path: "notes/flap.md", content: "v1" });
    expect(adapter.pendingCount()).toBe(1);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
    const result = await adapter.write({ path: "notes/flap.md", content: "v2" });
    expect(result).toEqual({ delivered: true });
    expect(adapter.pendingCount()).toBe(0);
  });
});

describe("ObsidianRestAdapter.list", () => {
  it("accepts an empty string (vault root) and returns the listed files", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: ["a.md", "b.md"] }),
    });
    const result = await adapter.list("");
    expect(result).toEqual(["a.md", "b.md"]);
  });
});

describe("ObsidianRestAdapter retry exhaustion (2026-10-08)", () => {
  it("parks an exhausted write in dead_writes instead of deleting it", async () => {
    const qPath = join(queueDir, "exhaust.db");
    const a = new ObsidianRestAdapter({
      url: "https://obsidian.example.com", apiKey: "k", queuePath: qPath, maxAttempts: 1,
    });
    try {
      mockFetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
      await a.write({ path: "notes/kept.md", content: "must survive" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q = (a as any).queue;
      q.prepare("UPDATE pending_writes SET next_retry_at = 0").run();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (a as any).processQueue();
      expect(q.prepare("SELECT COUNT(*) n FROM pending_writes").get().n).toBe(0);
      const dead = q.prepare("SELECT path, content, attempts FROM dead_writes").all();
      expect(dead).toEqual([{ path: "notes/kept.md", content: "must survive", attempts: 1 }]);
    } finally {
      a.close();
    }
  });

  it("keeps retrying below maxAttempts", async () => {
    const a = new ObsidianRestAdapter({
      url: "https://obsidian.example.com", apiKey: "k", queuePath: join(queueDir, "below.db"), maxAttempts: 5,
    });
    try {
      mockFetch.mockRejectedValue(new Error("down"));
      await a.write({ path: "notes/x.md", content: "c" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q = (a as any).queue;
      q.prepare("UPDATE pending_writes SET next_retry_at = 0").run();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (a as any).processQueue();
      expect(q.prepare("SELECT attempts FROM pending_writes").get().attempts).toBe(1);
      expect(q.prepare("SELECT COUNT(*) n FROM dead_writes").get().n).toBe(0);
    } finally {
      a.close();
    }
  });
});
