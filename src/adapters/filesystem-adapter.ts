import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { VaultAdapter, VaultWriteOptions } from "./vault-adapter.js";

export class FilesystemAdapter implements VaultAdapter {
  constructor(private vaultRoot: string) {}

  async write({ path, content, overwrite = true }: VaultWriteOptions): Promise<void> {
    const fullPath = join(this.vaultRoot, path);
    if (!overwrite && existsSync(fullPath)) return;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  async read(path: string): Promise<string> {
    return readFileSync(join(this.vaultRoot, path), "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(join(this.vaultRoot, path));
  }
}
