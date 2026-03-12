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
  adapters/       VaultAdapter interface + FilesystemAdapter + CouchDBAdapter
  index-http.ts   HTTP entry point — StreamableHTTP transport for Claude.ai (2025-03-26 spec)
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
- Companion IDs are always lowercase in config. Tool inputs normalize via `.toLowerCase()` — callers may pass any casing.
- All paths written to the vault must end in `.md`. `capture.ts` enforces this automatically via `ensureMd()`.
- The CouchDB adapter is used automatically when `couchdb` is present in config — `vault.adapter` is ignored in that case.
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

## VPS Deployment Plan

**Goal:** Move second-brain from local to an Ubuntu VPS so it runs 24/7.

### Sync Architecture

```
VPS (second-brain runs here, writes vault files)
    ↕  Obsidian LiveSync via CouchDB (also on VPS)
Mobile / Desktop / any device (all sync directly to VPS)
```

- **No local machine dependency.** All devices sync directly to CouchDB on the VPS.
- Works when your laptop is closed, asleep, or away.
- **Obsidian LiveSync** plugin replaces Obsidian Sync on all devices.
- The SQLite vector store (`~/.nullsafe-second-brain/vector-store.db`) stays local to the VPS only — excluded from vault sync.
- CouchDB runs on the VPS alongside second-brain, ideally behind a reverse proxy (Caddy recommended) with HTTPS.

### VPS Setup Checklist (in order)

**Server hardening**
- [ ] SSH key-based auth working (password auth disabled)
- [ ] Non-root user created
- [ ] UFW firewall enabled (allow 22, 80, 443 only)

**CouchDB + LiveSync**
- [x] CouchDB installed and running (`systemctl status couchdb` → active)
- [x] CouchDB admin password set, bound to localhost only
- [x] Caddy installed and running
- [x] Caddy proxies `https://db.softcrashentity.com` → `localhost:5984`
- [x] CouchDB database `obsidian-vault` created and receiving writes (10+ docs confirmed)
- [x] LiveSync plugin configured on all devices and syncing
- [x] Verify: write from Claude.ai → appears in Obsidian within seconds ✓ (confirmed 2026-03-12)

**Second-brain deployment**
- [x] Node.js installed (via nvm)
- [x] Repo cloned to VPS, `npm install`, `npm run build`
- [x] `second-brain.config.json` created on VPS (`chmod 600`)
- [x] CouchDBAdapter writes directly to CouchDB in LiveSync format — no vault path needed
- [x] second-brain running as a `systemd` service (auto-restart on reboot)
- [x] HTTP MCP transport live at `https://mcp.softcrashentity.com/mcp`
- [x] Claude.ai connects, authenticates via OAuth, and can see + call all tools

**Debugging Log (2026-03-10 → 2026-03-12):**
- **Fix 1:** Tools in `src/server.ts` lacked string descriptions. Claude drops tools without descriptions. *Added descriptions to all tools.*
- **Fix 2 (2026-03-10):** `src/index-http.ts` originally used `StreamableHTTPServerTransport` but was rolled back to `SSEServerTransport`. Then rolled back again — Claude.ai actually requires the **2025-03-26 Streamable HTTP spec** (`POST /mcp`), not SSE (`GET /mcp`). *Rewrote `index-http.ts` to use `StreamableHTTPServerTransport` with session registry.*
- **Fix 3:** `OPTIONS` preflight requests were failing `401` because Bearer auth ran before CORS. *Moved `cors()` above auth middleware.*
- **Fix 4:** `req.body` wasn't being passed to `handlePostMessage`. *Added `req.body` to handler.*
- **Fix 5 (2026-03-11):** OAuth `exchangeAuthorizationCode` missing `expires_in`, `verifyAccessToken` had hardcoded `clientId: "claude-ai"`. *Added `tokenToClientId` map, added `expires_in: 31536000` to token responses.*
- **Fix 6 (2026-03-11):** Vault writes not appearing in Obsidian — CouchDB was receiving writes fine (confirmed), but LiveSync not yet configured on devices. LiveSync database lock warning resolved by going through setup wizard.
- **Fix 7 (2026-03-11):** Custom `path` arguments without `.md` extension caused LiveSync to reject files. *Added `ensureMd()` safeguard in `capture.ts`.*
- **Fix 8 (2026-03-11):** Companion IDs case-sensitive — config uses lowercase (`drevan`) but Claude.ai passes capitalized (`Drevan`). *Added `.toLowerCase()` normalization in `capture.ts`.*
- **Fix 9 (2026-03-11):** Tool errors were swallowed silently with no server-side logging. *Added `run()` wrapper in `server.ts` that logs to stderr before rethrowing.*
- **Fix 10 (2026-03-12):** CouchDB chunk `data` field was base64-encoded; LiveSync stores raw UTF-8 strings for text files. This caused the content to appear as base64 garbage in Obsidian. *Changed `data: slice.toString("base64")` → `slice.toString("utf-8")` and simplified `read()` to use data as-is.* Root cause confirmed by reading LiveSync source (livesync-commonlib `EntryManagerImpls.ts`): `{ _id: id, data: data, type: "leaf" }` where data is the raw string from the splitter.
- **Fix 11 (2026-03-12):** Metadata `type` field was `"newnote"` for new docs. LiveSync source confirms `"newnote"` is for binary files; `.md` files should always be `"plain"`. *Changed to always `"plain"`.*
- **Fix 12 (2026-03-12):** Metadata `size` field was base64 string length (e.g. 252) instead of raw byte count (e.g. 189). LiveSync's corruption check compares assembled chunk string length against `size` — mismatch = "corrupted (189 != 252)". *Changed to `buf.length` (UTF-8 byte count).*

**Current State (2026-03-12): FULLY WORKING ✓**
- OAuth + MCP connection: **working** ✓
- CouchDB writes: **working** ✓
- Tool execution: **working** ✓ (`sb_save_document` confirmed)
- LiveSync → Obsidian sync: **working** ✓ (confirmed end-to-end 2026-03-12)

**Verify**
- [x] `sb_save_document` succeeds and file appears in Obsidian within seconds ✓
- [ ] Reboot VPS → second-brain and CouchDB both come back automatically
- [ ] Rotate `http.api_key` in config (current key was exposed in chat on 2026-03-11)

### Systemd Service

Create `/etc/systemd/system/second-brain.service`:
```ini
[Unit]
Description=Nullsafe Second Brain MCP Server
After=network.target

[Service]
Type=simple
User=<your-vps-user>
WorkingDirectory=/home/<your-vps-user>/nullsafe-second-brain
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable with: `sudo systemctl enable --now second-brain`

## Security

Full OWASP + vibesec audit run 2026-03-09. No fixes applied yet.

**Status: Server is live on VPS.** Known outstanding items:
1. `second-brain.config.json` was created and filled in from the example
2. The `halseth.secret` in config equals `ADMIN_SECRET` in the halseth Cloudflare Worker
3. The auth header fix is already in place: `src/clients/halseth-client.ts` sends `Authorization: Bearer` (not `x-halseth-secret`) — this was applied 2026-03-09 as part of the suite security pass

| Severity | Location | Issue |
|----------|----------|-------|
| **Medium** | `second-brain.config.json` (runtime) | Config file stores `halseth.secret`, `obsidian_rest.api_key`, and `embeddings.api_key` in plaintext JSON. Fix: restrict file permissions to owner-only (`chmod 600`). Consider moving secrets to env vars instead. |
| **Medium** | `src/tools/synthesis.ts` | Halseth session data is embedded directly into vault markdown without sanitization — prompt injection pathway from Halseth → vault → RAG → Claude context. Fix: HTML/markdown-escape string values from external HTTP responses before embedding in vault. |
| **Medium** | `src/clients/halseth-client.ts`, `src/clients/plural-client.ts`, `src/embeddings/openai-embedder.ts` | No schema validation on HTTP responses — responses cast directly to expected types with no Zod check. A malformed response is processed silently. Also: no `AbortSignal` / timeout on any fetch call — server can hang indefinitely if halseth is slow. |
| **Medium** | `src/tools/capture.ts` | User-supplied `path` and `subject` params are not length-clamped before being passed to `safePath()`. `safePath()` catches traversal, but unbounded strings could hit OS path length limits. Fix: add `.max(256)` to `path` and `subject` Zod schemas in `server.ts`. |
| **Low** | `src/server.ts:33` | `mkdirSync(dbDir)` called without `mode` argument — directory inherits umask. Fix: `mkdirSync(dbDir, { recursive: true, mode: 0o700 })` to restrict to owner. |
| **Low** | `src/store/vector-store.ts` | SQLite vector store is unencrypted on disk. All indexed companion content is readable by any process with filesystem access. Acceptable for local use, but document that the DB should live on an encrypted volume. |
