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

## Security

Full OWASP + vibesec audit run 2026-03-09. No fixes applied yet.

**Status: This server has never been launched.** Before first launch, verify:
1. `second-brain.config.json` was created and filled in from the example
2. The `halseth.secret` in config equals `ADMIN_SECRET` in the halseth Cloudflare Worker
3. The auth header fix is already in place: `src/clients/halseth-client.ts` sends `Authorization: Bearer` (not `x-halseth-secret`) — this was applied 2026-03-09 as part of the suite security pass

| Severity | Location | Issue |
|----------|----------|-------|
| **Medium** | `second-brain.config.json` (runtime) | Config file stores `halseth.secret`, `obsidian_rest.api_key`, and `embeddings.api_key` in plaintext JSON. Fix: restrict file permissions to owner-only (`chmod 600`). Consider moving secrets to env vars instead. |
| **Medium** | `src/tools/synthesis.ts` | Halseth session data (`front_state`, `notes`, `emotional_frequency`, etc.) is embedded directly into vault markdown without sanitization — prompt injection pathway from Halseth → vault → RAG → Claude context. Fix: HTML/markdown-escape string values from external HTTP responses before embedding in vault. |
| **Medium** | `src/clients/halseth-client.ts`, `src/clients/plural-client.ts`, `src/embeddings/openai-embedder.ts` | No schema validation on HTTP responses — responses cast directly to expected types with no Zod check. A malformed response is processed silently. Also: no `AbortSignal` / timeout on any fetch call — server can hang indefinitely if halseth is slow. |
| **Medium** | `src/tools/capture.ts` | User-supplied `path` and `subject` params are not length-clamped before being passed to `safePath()`. `safePath()` catches traversal, but unbounded strings could hit OS path length limits. Fix: add `.max(256)` to `path` and `subject` Zod schemas in `server.ts`. |
| **Low** | `src/server.ts:33` | `mkdirSync(dbDir)` called without `mode` argument — directory inherits umask. Fix: `mkdirSync(dbDir, { recursive: true, mode: 0o700 })` to restrict to owner. |
| **Low** | `src/store/vector-store.ts` | SQLite vector store is unencrypted on disk. All indexed companion content is readable by any process with filesystem access. Acceptable for local use, but document that the DB should live on an encrypted volume. |
