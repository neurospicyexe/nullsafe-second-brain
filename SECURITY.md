# Security — nullsafe-second-brain

## Reporting a Vulnerability

If you find a security vulnerability in this code, please report it privately before public disclosure. Open a GitHub security advisory on this repository or contact the maintainer directly. Do not post exploit details publicly until there has been a chance to patch. See the root [SECURITY.md](../SECURITY.md) for full context on this project's security posture.

---

This service runs on your BerryByte VPS and handles memory synthesis and semantic search. It reads from Halseth and writes to your Obsidian vault.

See root `SECURITY.md` at `C:\dev\Bigger_Better_Halseth\SECURITY.md` for the full architecture overview and 2FA guidance.

---

## What's Protected Here

| Data | Where | Who can access |
|------|-------|---------------|
| Obsidian vault files | CouchDB on VPS | Anyone with CouchDB credentials |
| Vector embeddings | Local vector store on VPS | Anyone with VPS access |
| Synthesis outputs | Written back to Halseth | Anyone with HALSETH_SECRET |

---

## Secrets Used by This Service

| Secret | Where | Risk if leaked |
|--------|-------|---------------|
| `HALSETH_URL` + `HALSETH_SECRET` | `~/.env` on VPS | Read/write access to all Halseth data |
| `OPENAI_API_KEY` | `~/.env` on VPS | API credit usage (embeddings) |
| `DEEPSEEK_API_KEY` | `~/.env` on VPS | API credit usage (synthesis) |
| HTTP API key | `second-brain.config.json` on VPS | Corpus ingestion access |

The `.env` file is on the VPS only — never on your local machine, never in git.

---

## VPS Access

Only SSH key holders and BerryByte console users can access the VPS. Caddy handles HTTPS so all traffic is encrypted in transit. The raw service runs on a local port (not exposed publicly) — Caddy proxies it through the domain.

---

## If the VPS Is Compromised

1. Change BerryByte console password immediately
2. Rotate SSH keys: add a new key, remove old one via `~/.ssh/authorized_keys`
3. Rotate `HALSETH_SECRET` in the `.env` file (and update everywhere else — see Halseth's SECURITY.md)
4. Rotate `OPENAI_API_KEY` and `DEEPSEEK_API_KEY` in their respective dashboards
