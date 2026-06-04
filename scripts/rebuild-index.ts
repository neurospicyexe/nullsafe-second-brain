// scripts/rebuild-index.ts
// Full rebuild of the SQLite vector index from the source of truth (the vault).
// Run with: npm run rebuild   (or: npx tsx scripts/rebuild-index.ts)
// Requires: second-brain.config.json present (vault path + embeddings model).
//
// The vault is truth; the vector store (embeddings + FTS5 + vec0 ANN) is
// disposable. This wipes the store and re-embeds the currently-indexed corpus in
// the configured model's space, preserving companion/content_type/tags per path.
// Run it after an embedding-model swap, or any time the index and vault drift.

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { indexer } = createServer(config);

  console.error(`[rebuild] model: ${config.embeddings.model}`);
  console.error("[rebuild] wiping vector store and re-embedding from vault...");

  const started = Date.now();
  const result = await indexer.rebuildAll();
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.error(`[rebuild] done in ${secs}s — ${result.paths} paths, ${result.chunks} chunks.`);
}

main().catch((err) => {
  console.error("[rebuild] FAILED:", err);
  process.exit(1);
});
