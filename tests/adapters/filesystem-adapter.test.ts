import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemAdapter } from "../../src/adapters/filesystem-adapter.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("FilesystemAdapter", () => {
  let tmpVault: string;
  let adapter: FilesystemAdapter;

  beforeEach(() => {
    tmpVault = mkdtempSync(join(tmpdir(), "vault-test-"));
    adapter = new FilesystemAdapter(tmpVault);
  });

  afterEach(() => rmSync(tmpVault, { recursive: true }));

  it("writes a file and reads it back", async () => {
    await adapter.write({ path: "test/note.md", content: "# Hello" });
    const content = await adapter.read("test/note.md");
    expect(content).toBe("# Hello");
  });

  it("creates intermediate directories", async () => {
    await adapter.write({ path: "deep/nested/folder/note.md", content: "content" });
    expect(await adapter.exists("deep/nested/folder/note.md")).toBe(true);
  });

  it("overwrites by default when file exists", async () => {
    await adapter.write({ path: "note.md", content: "original" });
    await adapter.write({ path: "note.md", content: "new" });
    expect(await adapter.read("note.md")).toBe("new");
  });

  it("does not overwrite when overwrite is false and file exists", async () => {
    await adapter.write({ path: "note.md", content: "original" });
    await adapter.write({ path: "note.md", content: "new", overwrite: false });
    expect(await adapter.read("note.md")).toBe("original");
  });

  it("returns false for exists on missing file", async () => {
    expect(await adapter.exists("does-not-exist.md")).toBe(false);
  });

  it("throws on read of missing file", async () => {
    await expect(adapter.read("missing.md")).rejects.toThrow();
  });
});
