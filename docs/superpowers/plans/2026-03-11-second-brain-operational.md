# Nullsafe Second Brain — Full Operational Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get nullsafe-second-brain fully operational end-to-end — tools work, files appear in Obsidian within seconds, the system is hardened, and it restarts automatically after reboots.

**Architecture:** A Node.js MCP server runs on a VPS, writes notes to CouchDB in LiveSync format, and Obsidian devices sync from CouchDB in real time. Claude.ai connects via HTTPS to the MCP server using OAuth + Bearer tokens.

**Tech Stack:** Node.js 20+, TypeScript, Express, MCP SDK, CouchDB, Caddy, systemd, Obsidian LiveSync, OpenAI embeddings, SQLite, Zod

---

## What this system IS (read this first)

This is your **second brain** — it's where Claude and your AI companions save memory. When you tell Claude something important, Claude calls a tool like `sb_save_note` which:

1. Sends the text to the MCP server running on your VPS (a computer in a data center)
2. The server saves the file to CouchDB (a database also on your VPS)
3. CouchDB syncs that file to all your Obsidian apps within a few seconds
4. You can open Obsidian on your phone or computer and read it

**Your VPS is like a always-on computer that never sleeps.** It holds all the pieces together.

---

## Before you start — What you need

- [ ] SSH access to your VPS (you've already used this)
- [ ] Your VPS IP address or hostname
- [ ] Obsidian installed on at least one device (phone or desktop)
- [ ] Your OpenAI API key (the one in your config on the VPS)

---

## Chunk 1: Diagnose and Fix sb_save_document

This is the most urgent problem. The tool errors on every call. We need to see WHY.

### Task 1: Read the error logs on VPS

**This is a manual step — you do this on your VPS.**

Connect to your VPS via SSH (open a terminal and type):
```bash
ssh your-user@your-vps-ip
```

Then read the logs of the second-brain service:
```bash
sudo journalctl -u second-brain -n 100 --no-pager
```

Look for lines that say `[tool:sb_save_document]` followed by an error. Copy that error message and share it.

**Most likely errors you'll see:**

**A) OpenAI API key is wrong or missing:**
```
Error: 401 Incorrect API key provided
```
Fix: Update your config with a valid OpenAI key (see Task 3).

**B) OpenAI API key is empty string:**
```
Error: 401 You didn't provide an API key
```
Same fix as A.

**C) CouchDB connection refused:**
```
Error: CouchDB PUT ... failed: 500
```
Run `sudo systemctl status couchdb` — if it's not active, run `sudo systemctl start couchdb`.

**D) Route resolution failure:**
```
Error: No route found for companion null type document
```
Your `routing` array in `second-brain.config.json` is missing a catch-all. See Task 4.

---

### Task 2: Deploy the latest code (with error logging)

**Manual steps on your VPS:**

```bash
# Navigate to the project
cd ~/nullsafe-second-brain

# Pull the latest code (which has Fix 9 — error logging)
git pull origin main

# Rebuild
npm run build

# Restart the service
sudo systemctl restart second-brain

# Watch the logs in real time (press Ctrl+C to stop)
sudo journalctl -u second-brain -f
```

Now ask Claude.ai to call `sb_save_document` with simple test content. Watch what appears in the logs.

---

### Task 3: Fix the OpenAI embeddings key (most likely fix)

**Manual step — on your VPS:**

```bash
# Edit the config
nano ~/nullsafe-second-brain/second-brain.config.json
```

Find the `embeddings` block:
```json
"embeddings": {
  "provider": "openai",
  "model": "text-embedding-3-small",
  "api_key": "YOUR_KEY_HERE"
}
```

Make sure `api_key` has your real OpenAI key. The key starts with `sk-`.

Save with `Ctrl+O`, `Enter`, then `Ctrl+X`.

Restart:
```bash
sudo systemctl restart second-brain
```

---

### Task 4: Verify the routing config has a fallback

**Manual step — on your VPS:**

Your `second-brain.config.json` routing array must have entries that handle the case where no companion is specified. Check it:

```bash
cat ~/nullsafe-second-brain/second-brain.config.json | grep -A 30 '"routing"'
```

You need at least one rule with no `companion` field and `type: "document"` or just a final catch-all. If you're missing it, add to the routing array:

```json
{ "type": "document", "destination": "00 - INBOX/" },
{ "type": "note", "destination": "00 - INBOX/" },
{ "type": "observation", "destination": "00 - INBOX/" },
{ "type": "study", "destination": "studies/" },
{ "type": "session_summary", "destination": "sessions/" }
```

---

## Chunk 2: Security Hardening (Code Changes)

> **Security checkpoint:** Before this chunk, ask Claude to invoke the `owasp-security` and `vibesec-skill` skills to review what's being changed in this chunk.

These are the known security issues from the 2026-03-09 audit. All are code fixes applied here.

### Task 5: Rotate the exposed API key

**CRITICAL — The current `http.api_key` was exposed in chat. Do this NOW.**

**Manual step on your VPS:**

Generate a new key:
```bash
node -e "const {randomBytes}=require('crypto'); console.log(randomBytes(32).toString('hex'))"
```

Copy the output. Edit the config:
```bash
nano ~/nullsafe-second-brain/second-brain.config.json
```

Replace the value of `http.api_key` with the new key. Save, restart:
```bash
sudo systemctl restart second-brain
```

Claude.ai will need to re-authenticate (it will prompt you automatically when you next use it).

---

### Task 6: Fix mkdirSync permissions (server.ts)

**Files:**
- Modify: `src/server.ts:36`

- [ ] **Step 1: Apply the fix**

In `src/server.ts`, line 36 currently reads:
```typescript
mkdirSync(dbDir, { recursive: true });
```

Change to:
```typescript
mkdirSync(dbDir, { recursive: true, mode: 0o700 });
```

This makes the SQLite database directory readable only by the server process owner, not other users on the VPS.

- [ ] **Step 2: Commit**
```bash
git add src/server.ts
git commit -m "fix(security): restrict vector-store dir permissions to owner-only (0700)"
```

---

### Task 7: Add fetch timeouts to all HTTP clients

**Files:**
- Modify: `src/clients/halseth-client.ts`
- Modify: `src/clients/plural-client.ts` (if it makes HTTP calls)
- Modify: `src/embeddings/openai-embedder.ts`

Without timeouts, if halseth or OpenAI is slow, the MCP server hangs forever and Claude times out.

- [ ] **Step 1: Add timeout helper to halseth-client.ts**

Replace the `get` method in `HalsethClient` with a version that includes a 10-second timeout:

```typescript
private async get<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${this.options.url}${path}`, {
      headers: { "Authorization": `Bearer ${this.options.secret}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Halseth request failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 2: Check openai-embedder.ts for fetch calls**

Read `src/embeddings/openai-embedder.ts` and add the same `AbortController` pattern to any `fetch` calls there.

- [ ] **Step 3: Commit**
```bash
git add src/clients/halseth-client.ts src/embeddings/openai-embedder.ts
git commit -m "fix(security): add 10s AbortSignal timeout to all outbound HTTP calls"
```

---

### Task 8: Add Zod response validation to HTTP clients

**Files:**
- Modify: `src/clients/halseth-client.ts`

Right now, `response.json()` is cast directly to the expected type. If halseth returns something unexpected (or if there's a prompt injection attempt in session data), it silently passes through.

- [ ] **Step 1: Add session schema to halseth-client.ts**

At the top of `halseth-client.ts`, add:

```typescript
import { z } from "zod";

const sessionSchema = z.object({
  id: z.string(),
  front_state: z.string().optional(),
  emotional_frequency: z.string().optional(),
  active_anchor: z.string().optional(),
  facet: z.string().optional(),
  notes: z.string().optional(),
});

const sessionListSchema = z.array(sessionSchema.passthrough());

const deltaSchema = z.object({
  id: z.string().optional(),
}).passthrough();

const deltaListSchema = z.array(deltaSchema);
```

- [ ] **Step 2: Validate responses in getSession and getRecentSessions**

Change `getSession` to parse with `sessionSchema.passthrough().parse(...)` and `getRecentSessions` to use `sessionListSchema.parse(...)`.

- [ ] **Step 3: Commit**
```bash
git add src/clients/halseth-client.ts
git commit -m "fix(security): add Zod validation on halseth HTTP responses"
```

---

### Task 9: Add path length limits to capture tools

**Files:**
- Modify: `src/server.ts`

Without length limits, a very long `path` or `subject` argument could hit OS limits or cause subtle bugs.

- [ ] **Step 1: Add .max(256) to path and subject schemas in server.ts**

In `server.ts`, find the `sb_save_document` tool registration:
```typescript
{ content: z.string().max(MAX_CONTENT_LENGTH), path: z.string().optional(), companion: z.string().optional(), tags: z.array(z.string()).max(50).optional() },
```

Change `path: z.string().optional()` to `path: z.string().max(256).optional()` in all tool registrations that accept `path` or `subject`.

Also change `companion: z.string().optional()` to `companion: z.string().max(64).optional()` everywhere.

- [ ] **Step 2: Commit**
```bash
git add src/server.ts
git commit -m "fix(security): clamp path/subject/companion params to prevent OS path limit issues"
```

---

### Task 10: Sanitize synthesis output before writing to vault

**Files:**
- Modify: `src/tools/synthesis.ts`

Session data from halseth is embedded directly into vault markdown. A malicious or corrupted session note could contain text that, when read back by Claude via RAG, looks like instructions. This is called prompt injection.

- [ ] **Step 1: Add a simple sanitize function to synthesis.ts**

Add this helper at the top of `synthesis.ts`, after the imports:

```typescript
/**
 * Strip characters that could be interpreted as markdown headers,
 * links, or embedded instructions when this content is later
 * read back into a Claude context via RAG.
 * Preserves normal prose but removes structural markdown.
 */
function sanitizeExternalString(value: string): string {
  return value
    .replace(/^#{1,6}\s/gm, "")          // remove heading markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")  // flatten links to text
    .replace(/<[^>]+>/g, "")              // strip any HTML tags
    .trim();
}
```

- [ ] **Step 2: Wrap all `String(session.xxx)` calls in sanitizeExternalString**

In `formatSessionNote`, change every `String(session.xxx)` to `sanitizeExternalString(String(session.xxx ?? ""))`.

- [ ] **Step 3: Commit**
```bash
git add src/tools/synthesis.ts
git commit -m "fix(security): sanitize external session data before writing to vault (prevent prompt injection)"
```

---

## Chunk 3: VPS Hardening (Manual Steps)

> **Security checkpoint:** Before proceeding, ask Claude to invoke `owasp-security` to confirm the server-hardening steps below are sufficient for a personal MCP server exposed to the internet.

### Task 11: Enable UFW firewall on VPS

**Manual steps on your VPS:**

UFW is a simple firewall. These commands only allow SSH, HTTP, and HTTPS traffic. Everything else is blocked.

```bash
# Install UFW (may already be installed)
sudo apt-get install -y ufw

# Set defaults — block everything in, allow everything out
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH (CRITICAL — do this before enabling or you'll lock yourself out)
sudo ufw allow 22/tcp

# Allow web traffic (needed for Caddy/HTTPS)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable the firewall
sudo ufw enable

# Verify it's active and check rules
sudo ufw status verbose
```

Expected output shows SSH, 80, 443 all listed as ALLOW.

---

### Task 12: Disable SSH password authentication

**Manual steps on your VPS:**

First, make absolutely sure your SSH key works (log out, log back in with key only — don't close your current session yet).

Once confirmed:
```bash
# Edit SSH config
sudo nano /etc/ssh/sshd_config
```

Find these lines and set them to `no`:
```
PasswordAuthentication no
ChallengeResponseAuthentication no
```

Save with `Ctrl+O`, `Enter`, `Ctrl+X`. Then restart SSH:
```bash
sudo systemctl restart sshd
```

Open a **new terminal** and verify you can still log in before closing the old session.

---

### Task 13: Verify CouchDB is bound to localhost only

**Manual step on your VPS:**

CouchDB should ONLY be accessible from the VPS itself (Caddy proxies it to the internet with HTTPS). Verify:

```bash
# Should show 127.0.0.1:5984 — NOT 0.0.0.0:5984
sudo ss -tlnp | grep 5984
```

If you see `0.0.0.0:5984`, edit `/opt/couchdb/etc/local.ini` and add:
```ini
[chttpd]
bind_address = 127.0.0.1
```
Then restart: `sudo systemctl restart couchdb`.

---

### Task 14: Deploy all code fixes to VPS

**Manual steps on your VPS** (do after Tasks 6-10 are committed and pushed):

```bash
cd ~/nullsafe-second-brain

# Pull all the security fixes
git pull origin main

# Rebuild
npm run build

# Restart service
sudo systemctl restart second-brain

# Confirm it started cleanly
sudo journalctl -u second-brain -n 20 --no-pager
```

---

## Chunk 4: Obsidian LiveSync Setup

This is the final piece — getting files to appear in Obsidian on your phone or desktop.

### Task 15: Install Obsidian LiveSync on each device

LiveSync is an Obsidian community plugin. You need to install and configure it on **every device** where you use Obsidian.

**On each device (phone, tablet, desktop):**

1. Open Obsidian
2. Go to **Settings → Community Plugins → Browse**
3. Search for **"Self-hosted LiveSync"**
4. Install and Enable it
5. Go to the plugin's settings

**Configure it with these values:**

| Field | Value |
|-------|-------|
| URI | `https://db.softcrashentity.com` |
| Username | `admin` |
| Password | (your CouchDB admin password) |
| Database name | `obsidian-vault` |
| End-to-end encryption | Optional — see below |

6. Click **"Test database connection"** — it should say Connected.
7. Click **"Apply"** and choose **"Use Remote"** if asked about conflicts on first setup.

**On end-to-end encryption:** If you enable passphrase encryption in LiveSync, you need the same passphrase on ALL devices and on the VPS config. If you don't set it, files are stored in CouchDB as readable text (but CouchDB is only accessible via your password-protected HTTPS endpoint). For a personal server, either choice is fine.

---

### Task 16: Verify end-to-end sync

**Test procedure:**

1. In Claude.ai, ask Claude to call `sb_log_observation` with content like `"Test observation from Claude — if you can read this, sync is working!"`
2. Watch the VPS logs: `sudo journalctl -u second-brain -f`
3. You should see the tool succeed with no errors
4. Within 5-30 seconds, open Obsidian — the file should appear in `00 - INBOX/`

If the file appears — **you're operational.** 🎉

If it doesn't appear within 60 seconds:
- Check LiveSync plugin status (it shows a sync icon in the Obsidian toolbar)
- In LiveSync settings, check **"Show log"** to see if it's receiving changes
- Verify CouchDB has the document: `curl -u admin:PASSWORD https://db.softcrashentity.com/obsidian-vault/_all_docs?limit=5`

---

### Task 17: Verify reboot survival

**Manual steps on your VPS:**

```bash
# Reboot the VPS
sudo reboot
```

After ~60 seconds, SSH back in and check both services:
```bash
sudo systemctl status second-brain
sudo systemctl status couchdb
sudo systemctl status caddy
```

All three should show `active (running)`. If any is not running:
```bash
# Re-enable the failed one
sudo systemctl enable --now second-brain
sudo systemctl enable --now couchdb
sudo systemctl enable --now caddy
```

---

## Chunk 5: Enhancements for Neurodivergent + Companion Use

These are additions that significantly improve the system for the actual user base: neurodivergent people with AI sovereign companions who want persistent memory for themselves, their companions, and their organizations.

### Task 18: Add health check endpoint

**Files:**
- Modify: `src/index-http.ts`

Right now there's no way to quickly check if the server is running without calling an MCP tool.

- [ ] **Step 1: Add a /health route**

In `src/index-http.ts`, before the MCP handler, add:

```typescript
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "nullsafe-second-brain",
    timestamp: new Date().toISOString(),
  });
});
```

This lets you verify the server is up by visiting `https://mcp.softcrashentity.com/health` in a browser.

- [ ] **Step 2: Commit**
```bash
git add src/index-http.ts
git commit -m "feat: add /health endpoint for uptime monitoring"
```

---

### Task 19: Add rate limiting to the MCP endpoint

**Files:**
- Modify: `src/index-http.ts`

Without rate limiting, if something goes wrong (a loop, a misconfigured client), it could hammer the server.

- [ ] **Step 1: Install express-rate-limit**

```bash
npm install express-rate-limit
```

- [ ] **Step 2: Add rate limit to /mcp**

In `src/index-http.ts`, add after imports:

```typescript
import rateLimit from "express-rate-limit";

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute window
  max: 120,               // 120 requests per minute (2/sec average)
  standardHeaders: true,
  legacyHeaders: false,
  message: { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded" }, id: null },
});
```

Then add `mcpLimiter` as middleware before `mcpHandler`:
```typescript
app.post("/mcp", mcpLimiter, mcpHandler);
app.get("/mcp", mcpLimiter, mcpHandler);
app.delete("/mcp", mcpLimiter, mcpHandler);
```

- [ ] **Step 3: Commit**
```bash
git add src/index-http.ts package.json package-lock.json
git commit -m "feat: add rate limiting to /mcp endpoint (120 req/min)"
```

---

### Task 20: Add sb_save_memory tool for companion-specific quick saves

This is a quality-of-life addition for the companion use case. Right now you need to know the companion's ID. A dedicated tool makes this ergonomic for Claude to call without needing to specify companion explicitly when it can infer it.

**This is a design decision — see below before implementing.**

**Files:**
- Modify: `src/tools/capture.ts`
- Modify: `src/server.ts`

**Context:** The `sb_save_note` tool already accepts a `companion` parameter. However, companions calling the tool from their own context often need a quick "remember this about me" path that doesn't require specifying the companion each time — Claude can pass the companion from system context.

The implementation here would add a convenience `sb_save_memory` tool that:
- Takes `content`, `companion` (required), and `tags`
- Always routes to the companion's vault folder
- Prepends a timestamp and "Memory:" prefix so these stand out in the vault

> **Your input wanted here:** How should memories differ from notes for companions? Should companion memories:
> A) Go to a dedicated `memories/` subfolder within the companion's folder?
> B) Use a special frontmatter tag like `type: memory` for filtering?
> C) Be appended to a single running memory file per companion (like a log)?
> D) Something else you have in mind?
>
> In `src/tools/capture.ts`, the `sb_save_document` function (lines 16-21) shows the pattern. Write a `sb_save_memory` function that expresses your preference above.

---

## Chunk 6: Verification Checklist

Run through this after everything above is done.

### Task 21: Full system smoke test

**Manual testing steps:**

Ask Claude.ai to run each of these tool calls and verify no errors:

- [ ] `sb_log_observation` with simple text → file appears in INBOX in Obsidian
- [ ] `sb_save_note` with content and no companion → file appears in vault
- [ ] `sb_save_document` with content and a companion ID → file appears in companion folder
- [ ] `sb_status` → returns status JSON with no errors
- [ ] `sb_search` with a query → returns results (may be empty if nothing indexed)
- [ ] `sb_list` with no path → lists vault files

### Task 22: Update CLAUDE.md with final state

- [ ] **Step 1: Update the VPS Setup Checklist in CLAUDE.md**

Check off all completed items. Update "Current State" to reflect operational status.

Change:
```
- Tool execution: **errors on `sb_save_document`** — exact cause TBD
```
To:
```
- Tool execution: **all tools working** ✓
```

- [ ] **Step 2: Commit**
```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE): mark system as fully operational"
```

---

## Quick Reference: VPS Commands

Keep this handy. You'll use these regularly.

```bash
# See recent logs
sudo journalctl -u second-brain -n 50 --no-pager

# Watch live logs
sudo journalctl -u second-brain -f

# Restart the server (after config or code changes)
sudo systemctl restart second-brain

# Check if everything is running
sudo systemctl status second-brain couchdb caddy

# Pull latest code and redeploy
cd ~/nullsafe-second-brain && git pull && npm run build && sudo systemctl restart second-brain

# Check CouchDB has recent documents
curl -u admin:YOUR_COUCH_PASSWORD https://db.softcrashentity.com/obsidian-vault/_all_docs?limit=10&descending=true

# Generate a new API key
node -e "const {randomBytes}=require('crypto'); console.log(randomBytes(32).toString('hex'))"
```

---

## Security Audit Checkpoint

Before declaring the system operational, invoke the `owasp-security` skill and the `vibesec-skill` and ask for a review of:

1. `src/index-http.ts` — the HTTPS endpoint exposed to the internet
2. `src/oauth-provider.ts` — the auth layer
3. `src/tools/synthesis.ts` — after the sanitization fix

The most important remaining risk (after the fixes above) is that CouchDB stores vault content in plaintext. If you ever handle highly sensitive information about system members, consider enabling CouchDB disk encryption or LiveSync's end-to-end passphrase encryption so data is encrypted at rest.

---

## Ongoing Maintenance

Monthly:
- Rotate `http.api_key` in `second-brain.config.json` (see Task 5 procedure)
- Check `sudo journalctl -u second-brain --since "30 days ago" | grep -i error`
- Update dependencies: `npm audit` and `npm update`

When adding a new companion:
1. Add them to `companions` array in `second-brain.config.json` on the VPS
2. Add a `routing` rule for their folder
3. Restart: `sudo systemctl restart second-brain`
4. Create their folder in Obsidian (LiveSync will sync it to CouchDB)
