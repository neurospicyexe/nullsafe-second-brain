# Second-Brain VPS Deployment

**Current state (as of 2026-03-13): FULLY WORKING**
- OAuth + MCP connection, CouchDB writes, tool execution, LiveSync → Obsidian sync, session persistence across restarts -- all confirmed working.

## Architecture

```
VPS (second-brain runs here, writes vault files)
    ↕  Obsidian LiveSync via CouchDB (also on VPS)
Mobile / Desktop / any device (all sync directly to VPS)
```

- No local machine dependency. All devices sync directly to CouchDB on the VPS.
- SQLite vector store stays local to VPS only (`~/.nullsafe-second-brain/vector-store.db`).
- CouchDB behind Caddy reverse proxy with HTTPS.
- Live URL: `https://mcp.softcrashentity.com/mcp`

## Setup Checklist

**Server hardening**
- [x] SSH key-based auth (password auth disabled)
- [x] Non-root user
- [x] UFW firewall (allow 22, 80, 443 only)

**CouchDB + LiveSync**
- [x] CouchDB installed, admin password set, bound to localhost only
- [x] Caddy proxies `https://db.softcrashentity.com` → `localhost:5984`
- [x] CouchDB database `obsidian-vault` created and receiving writes
- [x] LiveSync configured on all devices and syncing

**Second-brain deployment**
- [x] Node.js via nvm, repo cloned, `npm install`, `npm run build`
- [x] `second-brain.config.json` created on VPS (`chmod 600`)
- [x] CouchDBAdapter writes directly to CouchDB in LiveSync format
- [x] Running as systemd service (auto-restart on reboot)
- [x] HTTP MCP transport live at `https://mcp.softcrashentity.com/mcp`
- [x] Claude.ai connects via OAuth and can see all tools
- [ ] Reboot VPS → verify both services come back automatically
- [ ] Rotate `http.api_key` in config (key exposed in chat 2026-03-11)

## Systemd Service

`/etc/systemd/system/second-brain.service`:

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

## Debugging History

Key fixes that resolved deployment issues (2026-03-10 → 2026-03-13):

1. Added string descriptions to all MCP tools -- Claude drops tools without descriptions.
2. Rewrote `index-http.ts` to use `StreamableHTTPServerTransport` -- Claude.ai requires the 2025-03-26 spec (`POST /mcp`), not SSE (`GET /mcp`).
3. Moved `cors()` above auth middleware -- OPTIONS preflight was failing 401.
4. Added `req.body` to `handlePostMessage`.
5. Fixed OAuth `exchangeAuthorizationCode`: added `tokenToClientId` map, `expires_in: 31536000`.
6. Configured LiveSync on devices after CouchDB writes confirmed working.
7. Added `ensureMd()` safeguard in `capture.ts` -- paths without `.md` caused LiveSync rejection.
8. Added `.toLowerCase()` normalization in `capture.ts` -- config uses lowercase, Claude.ai passes capitalized.
9. Added `run()` wrapper in `server.ts` that logs to stderr before rethrowing.
10. Changed CouchDB chunk `data` field from base64 to raw UTF-8 strings -- LiveSync stores raw strings for text files.
11. Changed metadata `type` from `"newnote"` to `"plain"` -- `.md` files must always be `"plain"`.
12. Changed `size` field to `buf.length` (UTF-8 byte count) -- LiveSync corruption check compares string length against `size`.
13. Applied OWASP + vibesec security fixes (CORS restriction, fetch timeouts, prompt injection escaping, etc.).
14. Added `GET /sessions` and `GET /sessions/:id` to Halseth; fixed three broken client methods.
15. Fixed stale session ID handling -- fresh restart no longer rejects all requests with 400.
