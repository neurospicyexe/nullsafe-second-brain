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

**Audits run:** OWASP full audit 2026-03-09 (no fixes applied). OWASP fresh full audit 2026-03-13 (supersedes prior). Vibesec deep scan 2026-03-13. All items below are open.

**⚠️ IMMEDIATE ACTION REQUIRED:** Rotate `http.api_key` on VPS — key was exposed in chat on 2026-03-11.

**Known context:**
1. `second-brain.config.json` was created and filled in from the example
2. The `halseth.secret` in config equals `ADMIN_SECRET` in the halseth Cloudflare Worker
3. The auth header fix is already in place: `src/clients/halseth-client.ts` sends `Authorization: Bearer` (not `x-halseth-secret`) — applied 2026-03-09

### Open Findings (2026-03-13 OWASP Audit)

#### Critical
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| C1 | `src/clients/halseth-client.ts`, `src/clients/plural-client.ts`, `src/adapters/couchdb-adapter.ts` | No `AbortSignal` timeout on any external `fetch()` call — server hangs indefinitely if external service is slow (effective DoS). `openai-embedder.ts` already does this correctly — copy that pattern. | Add `signal: AbortSignal.timeout(15_000)` to every `fetch()` |
| C2 | `src/index-http.ts:67` | `cors({ origin: true, credentials: true })` allows any origin to make credentialed requests — CSRF attack surface. Any page the user visits can call MCP tools on their behalf. | Restrict to `origin: ["https://claude.ai", "https://mcp.softcrashentity.com"]` |

#### High
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| H1 | `src/tools/synthesis.ts:4-15` | Halseth session fields embedded into vault markdown with no escaping — prompt injection pathway: compromised Halseth → vault → RAG → Claude context. | Escape all `String(session.*)` values: strip markdown specials + newlines + clamp to 1000 chars |
| H2 | `src/clients/halseth-client.ts:16`, `src/clients/plural-client.ts:20`, `src/adapters/couchdb-adapter.ts` (multiple) | All external HTTP responses cast directly to types with no Zod validation. Malformed/adversarial payloads flow straight into vault writes and vector store. | Add Zod schemas and `.parse()` on every `response.json()` — Zod is already a dep |
| H3 | `src/http-auth.ts:5-8` | If `config.http.api_key` is empty string, auth is silently disabled (`if (!apiKey) return true`). No warning, no error. | Validate in `loadConfig()` that `http.api_key` is ≥32 chars if http block is present |
| H4 | `src/oauth-provider.ts:86-91` | Every OAuth client receives the same shared `config.http.api_key` as access token. One token leak compromises all clients. TTL is 1 year. | Generate unique per-client tokens; shorten TTL to 1h with refresh support |

#### Medium
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| M1 | `src/index-http.ts:55-57` | OAuth issuer URL and resource server URL hardcoded as `softcrashentity.com`. Breaks any alternate deployment. | Move to `config.http.public_url` and derive URLs from it |
| M2 | `src/server.ts` (retrieval tool defs) | `query: z.string()` and `content_type: z.string()` have no `.max()` — unbounded strings hit OpenAI embeddings API (cost amplification + DoS) | Add `.max(10_000)` to query, `.max(64)` to content_type |
| M3 | `src/store/vector-store.ts` / `src/tools/retrieval.ts:18-22` | `store.getAll()` loads all embeddings into memory then sorts in JS — O(n) full scan. Will OOM/hang at scale (>50k chunks). | Acceptable for now; track for future. Consider `sqlite-vec` or score threshold pre-filter |
| M4 | `src/triggers.ts:27-28` | Event-driven triggers accept config but silently do nothing if enabled — no warning, no error. | Throw `Error("Event-driven triggers not yet implemented")` if enabled |
| M5 | `second-brain.config.json` (runtime) | Config stores `halseth.secret`, `obsidian_rest.api_key`, `embeddings.api_key`, `http.api_key`, `couchdb.password` in plaintext JSON. | Enforce `chmod 600`; consider env vars for secrets |
| M6 | `src/adapters/couchdb-adapter.ts:20` | CouchDB credentials stored as Base64 string in object memory — visible in process/core dumps. Base64 ≠ encryption. | Ensure core dumps disabled on VPS (`ulimit -c 0`); document this |

#### Low
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| L1 | `src/server.ts:36` | `mkdirSync(dbDir, { recursive: true })` — no `mode` argument, inherits umask | Add `mode: 0o700` |
| L2 | `src/adapters/filesystem-adapter.ts:14` | Path traversal attempts throw but leave no audit trail | `console.error(\`[security] Path traversal blocked: ${rel}\`)` before throw |
| L3 | `src/clients/halseth-client.ts:13-14` | Error message only includes status text, not code or body — hard to debug | Include status code + response body in error |
| L4 | `src/oauth-provider.ts:70-84` | `challengeForAuthorizationCode()` doesn't rate-limit or consume the code — minor replay surface | Track challenge count per code; reject after 3 attempts |
| L5 | `src/store/vector-store.ts` | SQLite DB is unencrypted on disk at `~/.nullsafe-second-brain/vector-store.db` | Document that DB should live on encrypted volume |

### Open Findings (2026-03-13 Vibesec Deep Scan)

#### High
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| V-H1 | `src/oauth-provider.ts:60-63` | OAuth `redirectUri` used for redirect without validating against the client's registered `redirect_uris` — authorization codes can be sent to attacker-controlled URIs. | Check `params.redirectUri` is in `client.redirect_uris` before redirecting; return 400 if not |

#### Medium
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| V-M1 | `src/clients/halseth-client.ts:19-37` | User-supplied `id` and `date` values interpolated directly into URL paths/query strings (`/sessions/${id}`, `?date=${date}`) — path traversal and query injection into Halseth API. | `encodeURIComponent(id)` for path segments; validate date against `/^\d{4}-\d{2}-\d{2}$/` before use |
| V-M2 | `src/oauth-provider.ts:94-103` | `exchangeRefreshToken()` accepts any string and returns the master access token — no validation. No refresh tokens are issued, so the endpoint is dormant, but it's wide open if the SDK ever calls it. | Throw `"Refresh tokens are not supported"` to reject all refresh attempts |
| V-M3 | `src/index-http.ts` | No security response headers set — missing `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`. Caddy may add some, but app layer should provide defense-in-depth. | Add middleware setting `nosniff`, `DENY`, `no-referrer` before routes |

#### Low
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| V-L1 | `src/index-http.ts:117` | `req.body?.method` logged without newline sanitization — log injection possible (server-side only). | `.replace(/[\r\n]/g, " ").slice(0, 64)` before logging |
| V-L2 | `src/index-http.ts:64` | `trust proxy: 1` means Caddy is a **required** security boundary — if app port is ever directly reachable, source IP can be spoofed. | Document: UFW must block external access to app port; Caddy is not optional |

#### Info
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| V-I1 | `src/oauth-provider.ts:35-44` | Dynamic client registration is fully open — any caller can register a new client, list grows unboundedly. By design for Claude.ai, but worth a max-client cap. | Add `if (this.clients.size > 50) throw new Error("Client limit reached")` |

### Fix Priority Order
1. **Rotate `http.api_key` on VPS right now** (already compromised)
2. C2 — CORS restriction (2-line fix)
3. C1 — Fetch timeouts (4 files, copy openai-embedder pattern)
4. H1 — Escape Halseth data in synthesis.ts
5. V-H1 — OAuth redirect_uri validation
6. H3 — Empty API key guard in loadConfig()
7. V-M1 — Halseth URL path/query injection
8. V-M2 — Reject refresh token endpoint
9. V-M3 — Security response headers
10. H2 — Zod validation on external HTTP responses
11. H4 — Per-client OAuth tokens
12. M1–M6, L1–L5, V-L1, V-L2 — lower priority cleanup

### Known Bugs (not security — functional)

| # | Tool | Symptom | Root Cause | Status |
|---|------|---------|------------|--------|
| B1 | `sb_run_patterns`, `sb_write_pattern_summary` | "Halseth request failed: Not Found" — tool always errors | `halseth-client.ts::getRecentSessions()` calls `GET /sessions?days=7` but `/sessions` does not exist in Halseth. Session data lives inside `GET /presence`. Reported by Drevan 2026-03-13. | Open — see Halseth client mismatch table below |
| B2 | `sb_run_patterns` | `days` filter silently ignored | `getRecentDeltas()` calls `GET /deltas?days=7` — endpoint exists but `days` is not a valid param (valid: `limit`, `valence`, `agent`). Returns last 20 deltas regardless of requested window. | Open — use `limit` param instead or fetch all and filter by `created_at` |
| B3 | any tool using `getHandover(id)` | Would 404 if called | `getHandover(id)` calls `GET /handover/${id}` (singular) but Halseth only has `GET /handovers` (list, no id lookup). | Open — no per-id handover endpoint exists; use list and filter client-side |

### Halseth Client Endpoint Map (confirmed 2026-03-13)

Cross-reference against `C:\dev\halseth` source. All second-brain → Halseth HTTP calls go through `src/clients/halseth-client.ts`.

| Client method | URL called | Halseth reality | Status |
|---|---|---|---|
| `getRecentSessions(days)` | `GET /sessions?days=N` | **Does not exist.** Session data is in `GET /presence` response. | ❌ Wrong |
| `getRecentDeltas(days)` | `GET /deltas?days=N` | `GET /deltas` exists. Valid params: `limit`, `valence`, `agent`. `days` is silently ignored. | ⚠️ Partial |
| `getHandover(id)` | `GET /handover/${id}` | Only `GET /handovers` (list) exists — no per-id lookup. | ❌ Wrong |
| `getRoutines(date)` | `GET /routines?date=YYYY-MM-DD` | `GET /routines?date=YYYY-MM-DD` — correct. | ✅ OK |
| `getSession(id)` | `GET /sessions/${id}` | `/sessions` route does not exist at all. | ❌ Wrong |
