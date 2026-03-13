import { mkdirSync, existsSync } from "fs";
import { readFile, writeFile, access, rename } from "fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "path";
import type { VaultAdapter, VaultWriteOptions } from "./vault-adapter.js";

export class FilesystemAdapter implements VaultAdapter {
  constructor(private vaultRoot: string) {}

  private safePath(relativePath: string): string {
    const root = resolve(this.vaultRoot);
    const resolved = resolve(join(root, relativePath));
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      console.error(`[security] Path traversal blocked: attempted="${relativePath}" resolved="${rel}"`);
      throw new Error(`Path resolves outside vault root`);
    }
    return resolved;
  }

  async write({ path, content, overwrite = true }: VaultWriteOptions): Promise<void> {
    const fullPath = this.safePath(path);
    if (!overwrite && existsSync(fullPath)) return;
    mkdirSync(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async read(path: string): Promise<string> {
    return readFile(this.safePath(path), "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.safePath(path));
      return true;
    } catch {
      return false;
    }
  }

  async move(from: string, to: string): Promise<void> {
    const fullFrom = this.safePath(from);
    const fullTo = this.safePath(to);
    mkdirSync(dirname(fullTo), { recursive: true });
    await rename(fullFrom, fullTo);
  }

  async list(dirPath = ""): Promise<string[]> {
    const { readdir } = await import("fs/promises");
    const fullPath = this.safePath(dirPath || ".");
    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      return entries.map(e => (dirPath ? `${dirPath}/${e.name}` : e.name));
    } catch {
      return [];
    }
  }
}
