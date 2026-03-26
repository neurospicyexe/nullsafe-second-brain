# Second-Brain Security Audit

OWASP full audit 2026-03-13 (supersedes 2026-03-09 audit). Vibesec deep scan 2026-03-13.
Completed findings are not tracked here -- they're in git history.

## IMMEDIATE: Rotate `http.api_key` on VPS
Key was exposed in chat on 2026-03-11. Still open as of last audit.

## Open Findings (OWASP 2026-03-13)

### High
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| H2 | `src/clients/halseth-client.ts`, `plural-client.ts`, `couchdb-adapter.ts` | All external HTTP responses cast to types with no Zod validation. Malformed/adversarial payloads flow into vault writes and vector store. | Add Zod schemas and `.parse()` on every `response.json()` |
| H4 | `src/oauth-provider.ts:86-91` | Every OAuth client gets the same shared `config.http.api_key` as access token. One token leak compromises all clients. TTL is 1 year. | Generate unique per-client tokens; shorten TTL to 1h with refresh |

### Medium
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| M1 | `src/index-http.ts:55-57` | OAuth issuer URL hardcoded as `softcrashentity.com`. Breaks any alternate deployment. | Move to `config.http.public_url` |
| M3 | `src/store/vector-store.ts` | `store.getAll()` full scan O(n) -- will OOM at scale (>50k chunks). | Acceptable for now; revisit at scale |
| M4 | `src/triggers.ts:27-28` | Event-driven triggers silently do nothing if enabled. | Throw if enabled |
| M5 | `second-brain.config.json` | Config stores multiple secrets in plaintext JSON. | Enforce `chmod 600`; consider env vars |
| M6 | `src/adapters/couchdb-adapter.ts:20` | CouchDB credentials stored as Base64 in object memory. Base64 ≠ encryption. | Ensure core dumps disabled (`ulimit -c 0`) |

### Low
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| L3 | `src/clients/halseth-client.ts:13-14` | Error message only includes status text, not code or body. | Include status code + response body |
| L4 | `src/oauth-provider.ts:70-84` | `challengeForAuthorizationCode()` doesn't rate-limit or consume the code. | Track challenge count; reject after 3 attempts |
| L5 | `src/store/vector-store.ts` | SQLite DB unencrypted at `~/.nullsafe-second-brain/vector-store.db`. | Document: DB should live on encrypted volume |

## Open Findings (Vibesec 2026-03-13)

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| V-M1 | `src/clients/halseth-client.ts` | `date` not yet validated against `/^\d{4}-\d{2}-\d{2}$/` (id encoding already done). | Add date regex validation |
| V-L2 | `src/index-http.ts:64` | `trust proxy: 1` -- Caddy is a **required** security boundary. If app port is ever directly reachable, source IP can be spoofed. | UFW must block external access to app port; Caddy is not optional |
