import { describe, it, expect, vi } from "vitest";
import { ReadThroughAdapter, type ReplicaAdapter } from "../adapters/read-through-adapter.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

const notFound = (p: string) => new Error(`File not found: ${p}`);
const down = () => new Error("Obsidian REST GET x failed: fetch failed");

function primaryMock(overrides: Partial<VaultAdapter> = {}): VaultAdapter {
  return {
    write: vi.fn(async () => ({ delivered: true as const })),
    read: vi.fn(async () => "from-primary"),
    exists: vi.fn(async () => true),
    list: vi.fn(async () => ["p/"]),
    move: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
    hasPending: vi.fn(() => false),
    ...overrides,
  };
}

function replicaMock(overrides: Partial<ReplicaAdapter> = {}): ReplicaAdapter {
  return {
    write: vi.fn(async () => { throw new Error("replica must never be written"); }),
    read: vi.fn(async () => "from-replica"),
    exists: vi.fn(async () => true),
    list: vi.fn(async () => ["r/a.md"]),
    listChildren: vi.fn(async () => ["r/a.md", "r/sub/"]),
    move: vi.fn(async () => { throw new Error("replica must never be moved"); }),
    delete: vi.fn(async () => { throw new Error("replica must never be deleted"); }),
    ...overrides,
  };
}

const quiet = { log: () => {} };

describe("ReadThroughAdapter reads", () => {
  it("reads from the replica when nothing is fresh, without touching the primary", async () => {
    const primary = primaryMock();
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    await expect(a.read("n.md")).resolves.toBe("from-replica");
    expect(primary.read).not.toHaveBeenCalled();
  });

  it("works with the PC off: replica answers while the primary would throw", async () => {
    const primary = primaryMock({ read: vi.fn(async () => { throw down(); }) });
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    await expect(a.read("n.md")).resolves.toBe("from-replica");
  });

  it("falls back to the primary for a note LiveSync has not uploaded yet", async () => {
    const replica = replicaMock({ read: vi.fn(async (p: string) => { throw notFound(p); }) });
    const a = new ReadThroughAdapter(primaryMock(), replica, quiet);
    await expect(a.read("new.md")).resolves.toBe("from-primary");
  });

  it("a real miss with the PC off throws 'File not found', not the tunnel error", async () => {
    const primary = primaryMock({ read: vi.fn(async () => { throw down(); }) });
    const replica = replicaMock({ read: vi.fn(async (p: string) => { throw notFound(p); }) });
    const a = new ReadThroughAdapter(primary, replica, quiet);
    await expect(a.read("gone.md")).rejects.toThrow(/^File not found: gone\.md/);
  });

  it("a path written moments ago reads from the primary first (replica may lag)", async () => {
    let t = 1_000;
    const primary = primaryMock();
    const replica = replicaMock();
    const a = new ReadThroughAdapter(primary, replica, { ...quiet, now: () => t, freshMs: 60_000 });
    await a.write({ path: "Raziel/N.md", content: "x" });
    await expect(a.read("raziel/n.md")).resolves.toBe("from-primary"); // case-insensitive
    expect(replica.read).not.toHaveBeenCalled();
    t += 61_000;
    await expect(a.read("raziel/n.md")).resolves.toBe("from-replica");
  });

  it("a fresh path still reads from the replica if the primary goes down", async () => {
    const primary = primaryMock({ read: vi.fn(async () => { throw down(); }) });
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    await a.write({ path: "n.md", content: "x" });
    await expect(a.read("n.md")).resolves.toBe("from-replica");
  });

  it("a path with a queued primary write reads from the primary first", async () => {
    const primary = primaryMock({ hasPending: vi.fn((p: string) => p === "q.md") });
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    await expect(a.read("q.md")).resolves.toBe("from-primary");
    await expect(a.read("other.md")).resolves.toBe("from-replica");
  });

  it("a write that throws still marks the path fresh", async () => {
    const primary = primaryMock({ write: vi.fn(async () => { throw new Error("boom"); }) });
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    await expect(a.write({ path: "w.md", content: "x" })).rejects.toThrow("boom");
    await expect(a.read("w.md")).resolves.toBe("from-primary");
  });
});

describe("ReadThroughAdapter exists", () => {
  it("replica yes is final", async () => {
    const primary = primaryMock();
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    expect(await a.exists("n.md")).toBe(true);
    expect(primary.exists).not.toHaveBeenCalled();
  });

  it("replica no asks the primary; primary down means no", async () => {
    const replica = replicaMock({ exists: vi.fn(async () => false) });
    expect(await new ReadThroughAdapter(primaryMock(), replica, quiet).exists("n.md")).toBe(true);
    const deadPrimary = primaryMock({ exists: vi.fn(async () => { throw down(); }) });
    expect(await new ReadThroughAdapter(deadPrimary, replica, quiet).exists("n.md")).toBe(false);
  });

  it("a just-deleted path asks the primary first", async () => {
    const primary = primaryMock({ exists: vi.fn(async () => false) });
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    await a.delete("d.md");
    expect(await a.exists("d.md")).toBe(false);
  });
});

describe("ReadThroughAdapter list", () => {
  it("uses the replica's REST-shaped one-level listing", async () => {
    const primary = primaryMock();
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    await expect(a.list("r")).resolves.toEqual(["r/a.md", "r/sub/"]);
    expect(primary.list).not.toHaveBeenCalled();
  });

  it("adds a direct child written moments ago that the replica has not caught up on", async () => {
    const a = new ReadThroughAdapter(primaryMock(), replicaMock(), quiet);
    await a.write({ path: "r/new.md", content: "x" });
    await a.write({ path: "r/sub/deep.md", content: "x" });
    await expect(a.list("r")).resolves.toEqual(["r/a.md", "r/sub/", "r/new.md"]);
  });

  it("falls back to the primary when the replica errors", async () => {
    const replica = replicaMock({ listChildren: vi.fn(async () => { throw new Error("couch down"); }) });
    const a = new ReadThroughAdapter(primaryMock(), replica, quiet);
    await expect(a.list("")).resolves.toEqual(["p/"]);
  });
});

describe("ReadThroughAdapter writes", () => {
  it("write, move and delete go to the primary only", async () => {
    const primary = primaryMock();
    const replica = replicaMock();
    const a = new ReadThroughAdapter(primary, replica, quiet);
    await a.write({ path: "a.md", content: "x" });
    await a.move("a.md", "b.md");
    await a.delete("b.md");
    expect(primary.write).toHaveBeenCalledTimes(1);
    expect(primary.move).toHaveBeenCalledWith("a.md", "b.md");
    expect(primary.delete).toHaveBeenCalledWith("b.md");
    expect(replica.write).not.toHaveBeenCalled();
  });

  it("passes the queue counters through from the primary", () => {
    const primary = primaryMock({ pendingCount: vi.fn(() => 7), hasPending: vi.fn(() => true) });
    const a = new ReadThroughAdapter(primary, replicaMock(), quiet);
    expect(a.pendingCount()).toBe(7);
    expect(a.hasPending("x.md")).toBe(true);
  });
});
