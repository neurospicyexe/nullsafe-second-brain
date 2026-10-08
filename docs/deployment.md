# Deployment (VPS)

Second Brain runs on the VPS as a **systemd** service. It is **not** under pm2; the Discord bots
are, which is the usual source of confusion. One supervisor per service.

| | |
|---|---|
| Unit | `second-brain.service` (versioned copy: `deploy/second-brain.service`) |
| Runs as | `nullsafe` (the unit's `User=`); restarts need root |
| Checkout | `/home/nullsafe/nullsafe-second-brain` |
| Entry point | `dist/index-http.js` (HTTP/OAuth transport for Claude.ai) |
| Port | `3001` (`http.port` in `second-brain.config.json`), exposed only through a Cloudflare Tunnel |
| Secrets | `/home/nullsafe/nullsafe-second-brain/.env`, mode `600`, loaded by `EnvironmentFile=` |

## Deploy an update

```bash
# build as nullsafe (npm lives under nullsafe's nvm and is NOT on root's PATH; non-login shells need nvm sourced)
ssh vps 'export NVM_DIR=$HOME/.nvm && source $NVM_DIR/nvm.sh && cd ~/nullsafe-second-brain && git pull && npm ci && npm run build'
# restart as root
ssh vps-root 'systemctl restart second-brain.service'
```

Then confirm it came back:

```bash
ssh vps 'curl -s localhost:3001/health'
```

`/health` returns `200 {"status":"ok"}` or `503 {"status":"degraded"}`. The body carries the cron
table, the embedder state (`pending_embed`, `pending_index`) and `vault_queue_pending`, the number of
vault writes the ObsidianRestAdapter has queued because Obsidian or its tunnel was unreachable. A
climbing `vault_queue_pending` with a healthy embedder means the Windows side is down, not this
service.

## Status and logs

```bash
ssh vps-root 'systemctl status second-brain.service --no-pager'
ssh vps-root 'journalctl -u second-brain.service -n 100 --no-pager'
ssh vps-root 'journalctl -u second-brain.service -f'          # follow
ssh vps-root 'journalctl -u second-brain.service --since "2 hours ago" --no-pager'
```

Logs go to the journal (stdout/stderr), not to a file. There is no `/app/logs/` for this service.

## First-time install

```bash
sudo cp deploy/second-brain.service /etc/systemd/system/second-brain.service
sudo systemctl daemon-reload
sudo systemctl enable --now second-brain.service
```

Edit the `ExecStart=` node path in the unit if the nvm version on the host differs.

## The EnvironmentFile rule

**Every secret the service needs lives in `.env` and reaches the process through
`EnvironmentFile=/home/nullsafe/nullsafe-second-brain/.env`. The unit never carries an
`Environment=KEY=value` line for a secret.**

Why this is a rule and not a preference: a baked `Environment=` value is placed in the process
environment by systemd *before* node starts. Both node's `--env-file` and `dotenv` leave a variable
alone if it is already set. So when a secret is rotated in `.env`, the stale baked copy keeps
winning, silently. That is exactly what happened 2026-06-28: the unit had `HALSETH_SECRET` baked
from before a rotation, every Halseth call returned 401, and Second Brain was unhooked for three
days before the 07-01 prod-readiness sweep found it (BBH `docs/implementation-log.md:111`). The
fix was to move the unit onto `EnvironmentFile=`; the rotation checklist now includes unit files.

Corollaries:

- Rotating a secret is `edit .env` then `systemctl restart second-brain.service`. Nothing else.
- Diffing the live unit against `deploy/second-brain.service` is part of any secret rotation.
  `ssh vps-root 'cat /etc/systemd/system/second-brain.service'` and look for any `Environment=`
  line; if one exists, the value in `.env` is not the value the process is using.
- `systemctl show second-brain.service -p Environment` reveals baked values; `EnvironmentFile`
  values do not appear there, which is the point.

## Companion pieces

- `docs/security-audit.md`: open OWASP findings.
- Root `OPS-MANUAL.md` (BBH repo): VPS access, cron map, the pm2 processes this service is not one of.
