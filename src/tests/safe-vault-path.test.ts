import { describe, it, expect } from "vitest";
import { assertVaultRelativePath } from "../adapters/safe-vault-path.js";

describe("assertVaultRelativePath", () => {
  it("returns a normal relative path unchanged", () => {
    expect(assertVaultRelativePath("00-INBOX/note.md")).toBe("00-INBOX/note.md");
  });

  it("throws on a .. segment", () => {
    expect(() => assertVaultRelativePath("../../outside/note.md")).toThrow("resolves outside vault root");
  });

  it("throws on a .. segment in the middle of the path", () => {
    expect(() => assertVaultRelativePath("folder/../../outside.md")).toThrow("resolves outside vault root");
  });

  it("throws on a leading slash (absolute path)", () => {
    expect(() => assertVaultRelativePath("/etc/passwd")).toThrow("resolves outside vault root");
  });

  it("throws on a drive-letter absolute path", () => {
    expect(() => assertVaultRelativePath("C:\\Windows\\system.ini")).toThrow("resolves outside vault root");
  });

  it("throws on a null byte", () => {
    expect(() => assertVaultRelativePath("note.md\0.txt")).toThrow("resolves outside vault root");
  });
});
