# CLAUDE.md

`nullsafe-second-brain` is a local MCP server (Node.js, TypeScript, stdio transport). Layer 2 in the Nullsafe ecosystem: reads from halseth and nullsafe-plural-v2 via HTTP, synthesizes content into an Obsidian vault, and maintains a SQLite vector store for companion RAG retrieval.

Part of the BBH suite -- see root `CLAUDE.md` for cross-project context.

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
  adapters/       VaultAdapter interface + FilesystemAdapter + CouchDBAdapter
  index-http.ts   HTTP entry point -- StreamableHTTP transport for Claude.ai (2025-03-26 spec)
  clients/        HalsethClient, PluralClient -- HTTP wrappers for external MCPs
  embeddings/     Embedder interface + OpenAIEmbedder
  store/          VectorStore -- SQLite via better-sqlite3
  tools/          capture.ts, retrieval.ts, synthesis.ts, system.ts -- MCP tool builders
  config.ts       loadConfig() -- zod-validated config loader
  indexer.ts      Indexer -- dual-write pipeline: vault write + embed + vector store insert
  router.ts       RouteResolver -- explicit path → config rules → 00 - INBOX/ default
  server.ts       createServer() -- wires all dependencies, registers MCP tools
  index.ts        Entry point -- loads config, creates server, connects stdio transport
```

## Key Invariants

- Companion names are never hardcoded. Always `companion.id` from config.
- Companion IDs are always lowercase in config. Tool inputs normalize via `.toLowerCase()`.
- All paths written to the vault must end in `.md`. `capture.ts` enforces this automatically via `ensureMd()`.
- The CouchDB adapter is used automatically when `couchdb` is present in config.
- `second-brain.config.json` is gitignored. Only `second-brain.config.example.json` is committed.
- The SQLite vector store lives in `~/.nullsafe-second-brain/vector-store.db` -- outside the vault folder.
- All vault writes go through `Indexer.write()` -- direct adapter calls bypass the vector store.
- `sb_log_observation` always routes to INBOX. Never writes directly to permanent folders.
- `relational_deltas` in halseth is read-only from this system -- we never write back to it.
- `reindex()` preserves companion/content_type/tags by reading existing metadata before deleting and re-inserting.

## Config Files

| File | Git | Purpose |
|------|-----|---------|
| `second-brain.config.example.json` | committed | Structure with placeholder values |
| `second-brain.config.json` | gitignored | Your actual config -- vault path, companion ids, API keys |

## Deployment

Runs on VPS at `mcp.softcrashentity.com`. Fully operational as of 2026-03-13.
Setup checklist, architecture, and debugging history: `docs/deployment.md`

## Security

OWASP full audit + vibesec deep scan 2026-03-13.
**Immediate action still open: rotate `http.api_key` on VPS** (key exposed in chat 2026-03-11).
Open findings: `docs/security-audit.md`
