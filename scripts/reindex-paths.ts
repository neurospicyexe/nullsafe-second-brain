// scripts/reindex-paths.ts
// Targeted (re)index of specific vault paths into the vector store.
// Run with: npx tsx scripts/reindex-paths.ts <path> [<path> ...]
// Requires: second-brain.config.json present (vault + embeddings model).
//
// Why this exists (2026-07-10): files copied directly into the Obsidian vault
// (e.g. LiveSync, or a manual drop into a folder) land in the vault but are NOT
// in the vector store, so `sb_search` can't find them. `rebuildAll()` won't help
// -- it only re-embeds paths ALREADY indexed; it does not enumerate the vault.
// The correct operation for a brand-new vault file is `indexer.reindex(path)`,
// which reads the file byte-exact from the vault (via the configured adapter),
// chunks it, and embeds it. No content passes through anything but the vault ->
// embedder path, so canon fidelity is preserved end to end.
//
// Used to index the `canon/` identity set (Constitution + identity files + shared
// modules) so every surface can pull the extended view via sb_search.

import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Paths come from argv, or from a newline-delimited file via `--from <file>`.
 *  The file form avoids shell-quoting pain for vault paths that contain spaces
 *  (e.g. "canon/ARCHITECT STANCE v1.md"). */
function collectPaths(argv: string[]): string[] {
  const fromIdx = argv.indexOf("--from");
  if (fromIdx !== -1) {
    const file = argv[fromIdx + 1];
    if (!file) return [];
    return readFileSync(file, "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }
  return argv.filter(Boolean);
}

async function main(): Promise<void> {
  const paths = collectPaths(process.argv.slice(2));
  if (paths.length === 0) {
    console.error("Usage: npx tsx scripts/reindex-paths.ts <vault-path> [...]  |  --from <file>");
    process.exit(2);
  }

  const config = loadConfig();
  const { indexer } = createServer(config);
  console.error(`[reindex-paths] model: ${config.embeddings.model} — ${paths.length} path(s)`);

  let ok = 0;
  const failed: Array<{ path: string; error: string }> = [];
  for (const path of paths) {
    try {
      await indexer.reindex(path);
      ok++;
      console.error(`[reindex-paths] ok: ${path}`);
    } catch (err) {
      // Surface, don't swallow -- a path that can't be read (not yet synced /
      // wrong path / adapter down) must be visible, not silently skipped.
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ path, error });
      console.error(`[reindex-paths] FAIL: ${path} -- ${error}`);
    }
  }

  console.error(`[reindex-paths] done — ${ok} ok, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[reindex-paths] FATAL:", err);
  process.exit(1);
});
