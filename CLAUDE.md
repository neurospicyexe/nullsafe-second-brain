# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Is

`nullsafe-second-brain` is a local MCP server (Node.js, TypeScript, stdio transport). It is Layer 2 in the Nullsafe ecosystem: it reads from halseth and nullsafe-plural-v2 via HTTP, synthesizes content into an Obsidian vault, and maintains a SQLite vector store for companion RAG retrieval.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (vitest) |
| `npm run dev` | Start the server with tsx (requires second-brain.config.json) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run compiled server (requires build first) |

## Architecture

```
src/
  adapters/       VaultAdapter interface + FilesystemAdapter + (future) ObsidianRESTAdapter
  clients/        HalsethClient, PluralClient — HTTP wrappers for external MCPs
  embeddings/     Embedder interface + OpenAIEmbedder
  store/          VectorStore — SQLite via better-sqlite3
  tools/          capture.ts, retrieval.ts, synthesis.ts, system.ts — MCP tool builders
  config.ts       loadConfig() — zod-validated config loader, exports SecondBrainConfig type
  indexer.ts      Indexer — dual-write pipeline: vault write + embed + vector store insert
  router.ts       RouteResolver — explicit path → config rules → 00 - INBOX/ default
  server.ts       createServer() — wires all dependencies, registers MCP tools
  triggers.ts     setupTriggers() — cron, on_demand, event_driven
  index.ts        Entry point — loads config, creates server, connects stdio transport
```

## Key Invariants

- Companion names are never hardcoded. Always `companion.id` from config.
- `second-brain.config.json` is gitignored. Only `second-brain.config.example.json` is committed.
- The SQLite vector store lives in `~/.nullsafe-second-brain/vector-store.db` — outside the vault folder so Obsidian Sync does not attempt to sync it.
- All vault writes go through `Indexer.write()` — direct adapter calls bypass the vector store.
- `sb_log_observation` always routes to INBOX. It never writes directly to permanent folders.
- `relational_deltas` in halseth is read-only from this system — we never write back to it.
- `reindex()` preserves companion/content_type/tags by reading existing metadata from the store before deleting and re-inserting.

## Config Files

| File | Git | Purpose |
|------|-----|---------|
| `second-brain.config.example.json` | committed | Structure with placeholder values |
| `second-brain.config.json` | gitignored | Your actual config — vault path, companion ids, API keys |
