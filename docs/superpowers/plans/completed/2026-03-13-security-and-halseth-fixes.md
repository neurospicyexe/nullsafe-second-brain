# Security Hardening + Halseth Communication Fixes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all open security vulnerabilities from the 2026-03-13 OWASP + vibesec audits and repair the broken Halseth↔second-brain communication so Drevan's synthesis tools work end-to-end.

**Architecture:** Changes span two repos. `nullsafe-second-brain` gets security hardening (CORS, timeouts, escaping, OAuth) and corrected Halseth client endpoints. `halseth` gets two new read-only GET endpoints (`/sessions` and `/sessions/:id`) — pure `SELECT` queries on an existing table, no schema changes, no data at risk.

**Tech Stack:** TypeScript, Node.js/Express (second-brain), Cloudflare Workers + D1 SQLite (halseth), Zod, Vitest

**Repos:**
- `C:\dev\nullsafe-second-brain` — primary
- `C:\dev\halseth` — additive only (two new read endpoints)

---

## File Map

### nullsafe-second-brain

| File | Action | What changes |
|------|--------|-------------|
| `src/index-http.ts` | Modify | CORS origin allowlist, security headers middleware, log sanitization |
| `src/config.ts` | Modify | `api_key` min length 1 → 32 |
| `src/server.ts` | Modify | `mkdirSync` mode 0o700, `query` + `content_type` `.max()` |
| `src/adapters/filesystem-adapter.ts` | Modify | Log path traversal attempts before throwing |
| `src/clients/halseth-client.ts` | Modify | AbortSignal timeout, better errors, encodeURIComponent, fix all broken endpoints |
| `src/clients/plural-client.ts` | Modify | AbortSignal timeout, better error |
| `src/adapters/couchdb-adapter.ts` | Modify | AbortSignal timeout on all 4 fetch calls |
| `src/tools/synthesis.ts` | Modify | `escapeMd()` helper, apply to all `String(session.*)` interpolations |
| `src/oauth-provider.ts` | Modify | redirect_uri validation, reject refresh tokens, client cap (50) |
| `src/tests/http-auth.test.ts` | Modify | Update empty-string test to document new config-level enforcement |
| `src/tests/config.test.ts` | Modify | Add test: api_key shorter than 32 chars fails validation |
| `src/tests/halseth-client.test.ts` | Create | Tests for corrected endpoint calls and timeout behavior |

### halseth

| File | Action | What changes |
|------|--------|-------------|
| `src/handlers/sessions.ts` | Create | `GET /sessions?days=N` and `GET /sessions/:id` — read-only |
| `src/router.ts` (or `src/index.ts`) | Modify | Register two new session routes |

---

## Chunk 1: Security Quick Wins (second-brain)

Five small, independent fixes. No tests needed for most — behavior is obvious. Where tests exist, update them.

---

### Task 1: CORS Restriction

**Files:**
- Modify: `src/index-http.ts:67`

- [ ] **Step 1: Update the cors() call**

```typescript
// Replace line 67 in src/index-http.ts:
// OLD:
app.use(cors({ origin: true, credentials: true }));

// NEW:
app.use(cors({
  origin: ["https://claude.ai", "https://mcp.softcrashentity.com"],
  credentials: true,
}));
```

- [ ] **Step 2: Build and verify no compile errors**

```bash
cd C:\dev\nullsafe-second-brain
npm run build
```
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/index-http.ts
git commit -m "fix(security): restrict CORS to known origins (C2)"
```

---

### Task 2: Security Response Headers

**Files:**
- Modify: `src/index-http.ts` (after CORS middleware, before body parser)

- [ ] **Step 1: Add header middleware**

In `src/index-http.ts`, after the `app.use(cors(...))` line and before `app.use(express.json(...))`, insert:

```typescript
// Security headers — defense-in-depth even behind Caddy proxy
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
```

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/index-http.ts
git commit -m "fix(security): add X-Content-Type-Options, X-Frame-Options, Referrer-Policy headers (V-M3)"
```

---

### Task 3: Log Injection Sanitization

**Files:**
- Modify: `src/index-http.ts:117`

- [ ] **Step 1: Sanitize the method field before logging**

Find this line in `mcpHandler` (around line 117):
```typescript
// OLD:
console.error(`[mcp] ${req.method} session=${sessionId?.slice(0, 8) ?? "none"} method=${method}`);
```

It needs to be split: first sanitize `method`, then log. Replace the two lines that set `method` and log it:

```typescript
// OLD (two lines, ~116-117):
const method = req.body?.method ?? req.method;
console.error(`[mcp] ${req.method} session=${sessionId?.slice(0, 8) ?? "none"} method=${method}`);

// NEW:
const method = String(req.body?.method ?? req.method).replace(/[\r\n]/g, " ").slice(0, 64);
console.error(`[mcp] ${req.method} session=${sessionId?.slice(0, 8) ?? "none"} method=${method}`);
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/index-http.ts
git commit -m "fix(security): sanitize request method field before logging (V-L1)"
```

---

### Task 4: API Key Minimum Length in Config Schema

**Files:**
- Modify: `src/config.ts:54`
- Modify: `src/tests/config.test.ts`

**Important:** After this change, the `api_key` in `second-brain.config.json` on the VPS **must be rotated to a value of at least 32 characters**. The key was already compromised (exposed in chat 2026-03-11), so rotation is required regardless.

- [ ] **Step 1: Write the failing test first**

In `src/tests/config.test.ts`, find the existing config tests and add:

```typescript
it("rejects api_key shorter than 32 characters", () => {
  // build a minimal valid config with a short key
  const short = { ...validHttpConfig, http: { port: 3000, api_key: "tooshort" } };
  expect(() => loadConfig(shortKeyConfigPath)).toThrow();
});
```

> Note: `config.test.ts` likely uses temp files or fixtures. Follow the existing pattern in that file for how it creates test configs. If it mocks `readFileSync`, mock it with a config that has `api_key: "tooshort"`.

- [ ] **Step 2: Run the test — verify it fails**

```bash
npm test -- config
```
Expected: Test fails because current schema allows short keys.

- [ ] **Step 3: Update the schema**

In `src/config.ts`, change line 54:
```typescript
// OLD:
api_key: z.string().min(1),

// NEW:
api_key: z.string().min(32, "http.api_key must be at least 32 characters — generate with: openssl rand -hex 32"),
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test -- config
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/tests/config.test.ts
git commit -m "fix(security): require api_key >= 32 chars in config schema (H3)"
```

- [ ] **Step 6: Rotate the key on VPS**

On the VPS, generate a new key and update the config:
```bash
openssl rand -hex 32
# Copy the output, then:
nano ~/nullsafe-second-brain/second-brain.config.json
# Update "api_key" to the new value
sudo systemctl restart second-brain
```
Then reconnect Claude.ai — it will re-run OAuth and get a new token.

---

### Task 5: Filesystem Hardening (mkdirSync mode + traversal logging)

**Files:**
- Modify: `src/server.ts:36`
- Modify: `src/adapters/filesystem-adapter.ts:13-14`

- [ ] **Step 1: Fix mkdirSync in server.ts**

```typescript
// OLD (server.ts ~line 36):
mkdirSync(dbDir, { recursive: true });

// NEW:
mkdirSync(dbDir, { recursive: true, mode: 0o700 });
```

- [ ] **Step 2: Add traversal logging in filesystem-adapter.ts**

```typescript
// OLD (filesystem-adapter.ts ~line 13-14):
if (rel.startsWith("..") || isAbsolute(rel)) {
  throw new Error(`Path resolves outside vault root`);
}

// NEW:
if (rel.startsWith("..") || isAbsolute(rel)) {
  console.error(`[security] Path traversal blocked: attempted path="${relativePath}" resolved="${rel}"`);
  throw new Error(`Path resolves outside vault root`);
}
```

- [ ] **Step 3: Build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/adapters/filesystem-adapter.ts
git commit -m "fix(security): restrict dbDir permissions to 0o700, log path traversal attempts (L1, L2)"
```

---

## Chunk 2: Fetch Timeouts + Error Improvements (second-brain)

Add `AbortSignal.timeout(15_000)` to every external `fetch()` call. The pattern already exists in `src/embeddings/openai-embedder.ts` — copy it exactly. Also improve error messages so failures tell you which endpoint failed.

---

### Task 6: Halseth Client — Timeout + Error Quality

**Files:**
- Modify: `src/clients/halseth-client.ts`

Note: Do NOT fix the broken endpoints yet — that's Task 10. This task only adds the timeout and improves the error message on the existing `get()` method.

- [ ] **Step 1: Write a test for timeout behavior**

Create `src/tests/halseth-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HalsethClient } from "../clients/halseth-client.js";

describe("HalsethClient", () => {
  const client = new HalsethClient({ url: "https://halseth.example.com", secret: "test-secret" });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes status code and path in error message on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "session not found",
    }));

    await expect(client.getSession("abc")).rejects.toThrow("404");
    await expect(client.getSession("abc")).rejects.toThrow("Not Found");
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
npm test -- halseth-client
```
Expected: FAIL — current error message only includes `statusText`, not the status code.

- [ ] **Step 3: Update the `get()` method in halseth-client.ts**

```typescript
private async get<T>(path: string): Promise<T> {
  const response = await fetch(`${this.options.url}${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { "Authorization": `Bearer ${this.options.secret}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Halseth ${path} → ${response.status} ${response.statusText}: ${body}`);
  }
  return response.json() as Promise<T>;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test -- halseth-client
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/clients/halseth-client.ts src/tests/halseth-client.test.ts
git commit -m "fix(security): add 15s timeout and improved error messages to HalsethClient (C1, L3)"
```

---

### Task 7: Plural Client — Timeout + Error Quality

**Files:**
- Modify: `src/clients/plural-client.ts`

- [ ] **Step 1: Update the fetch call**

```typescript
// OLD:
const response = await fetch(`${this.options.url}/front/current`);
if (!response.ok) {
  throw new Error(`Plural request failed: ${response.statusText}`);
}

// NEW:
const response = await fetch(`${this.options.url}/front/current`, {
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) {
  const body = await response.text().catch(() => "(unreadable)");
  throw new Error(`Plural /front/current → ${response.status} ${response.statusText}: ${body}`);
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/clients/plural-client.ts
git commit -m "fix(security): add 15s timeout and improved error to PluralClient (C1)"
```

---

### Task 8: CouchDB Adapter — Timeouts on All Fetches

**Files:**
- Modify: `src/adapters/couchdb-adapter.ts`

There are two private methods that call `fetch`: `getDoc()` and `putDoc()`. Both need `AbortSignal.timeout(15_000)`. The `list()` method also calls fetch directly.

- [ ] **Step 1: Update getDoc()**

```typescript
private async getDoc(id: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: this.headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CouchDB GET ${id} failed: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}
```

- [ ] **Step 2: Update putDoc()**

```typescript
private async putDoc(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(15_000),
    headers: this.headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CouchDB PUT ${id} failed: ${res.status}`);
}
```

- [ ] **Step 3: Update list() fetch**

```typescript
const res = await fetch(`${this.baseUrl}/_all_docs?include_docs=true`, {
  signal: AbortSignal.timeout(30_000),  // list can be slow on large vaults
  headers: this.headers(),
});
```

- [ ] **Step 4: Build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/adapters/couchdb-adapter.ts
git commit -m "fix(security): add AbortSignal timeouts to all CouchDB fetch calls (C1)"
```

---

## Chunk 3: Halseth Server Additions (halseth repo — read-only)

**⚠️ Data safety:** These are pure `SELECT` queries on the existing `sessions` table. No `INSERT`, `UPDATE`, `DELETE`, or schema migrations. The database cannot lose data from these changes.

**Sessions table columns** (from `migrations/0003_sessions_expand.sql`):
`id, created_at, updated_at, front_state, co_con, hrv_range, emotional_frequency, key_signature, active_anchor, facet, depth, spiral_complete, handover_id, notes`

---

### Task 9: Add GET /sessions and GET /sessions/:id to Halseth

**Files:**
- Create: `src/handlers/sessions.ts`
- Modify: `src/index.ts` (or wherever routes are registered — find the file that calls `router.on(...)` for `/handovers`, `/deltas`, etc.)

- [ ] **Step 1: Create the sessions handler**

```typescript
// src/handlers/sessions.ts
import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, isNaN(n) ? def : n), max);
}

// GET /sessions?days=7&limit=100
// Returns sessions created within the last N days, newest first.
export async function getSessions(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const rawDays = parseInt(url.searchParams.get("days") ?? "7", 10);
  const days = isNaN(rawDays) || rawDays < 1 ? 7 : Math.min(rawDays, 365);
  const limit = clampLimit(url.searchParams.get("limit"), 100, 200);

  const result = await env.DB.prepare(`
    SELECT id, created_at, updated_at, front_state, co_con,
           emotional_frequency, active_anchor, facet, notes
    FROM sessions
    WHERE created_at >= datetime('now', ? || ' days')
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(`-${days}`, limit).all<Record<string, unknown>>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /sessions/:id
// Returns a single session by id, or 404 if not found.
export async function getSessionById(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing session id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const row = await env.DB.prepare(`
    SELECT id, created_at, updated_at, front_state, co_con,
           emotional_frequency, active_anchor, facet, notes
    FROM sessions
    WHERE id = ?
  `).bind(id).first<Record<string, unknown>>();

  if (!row) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(row), {
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Register the routes**

Find the file in `src/` that registers all HTTP routes (the one with calls like `router.on("GET", "/handovers", getHandovers)`). Add:

```typescript
import { getSessions, getSessionById } from "./handlers/sessions.js";

// In the route registration block:
router.on("GET", "/sessions", (req, env) => getSessions(req, env));
router.on("GET", "/sessions/:id", (req, env, params) => getSessionById(req, env, params));
```

- [ ] **Step 3: Build Halseth**

```bash
cd C:\dev\halseth
npm run build   # or: npx tsc --noEmit
```
Expected: No TypeScript errors.

- [ ] **Step 4: Test locally with wrangler (if configured)**

```bash
# Test the list endpoint
curl -H "Authorization: Bearer $ADMIN_SECRET" \
  "http://localhost:8787/sessions?days=7"
# Expected: JSON array (may be empty if no sessions in local D1)

# Test the by-id endpoint with a nonexistent id
curl -H "Authorization: Bearer $ADMIN_SECRET" \
  "http://localhost:8787/sessions/nonexistent"
# Expected: {"error":"Session not found"} with status 404
```

- [ ] **Step 5: Deploy to Cloudflare**

```bash
npx wrangler deploy --config wrangler.prod.toml
```
Expected: Deployment succeeds. Verify with:
```bash
curl -H "Authorization: Bearer $ADMIN_SECRET" \
  "https://halseth.softcrashentity.com/sessions?days=7"
```

- [ ] **Step 6: Commit in halseth repo**

```bash
cd C:\dev\halseth
git add src/handlers/sessions.ts src/index.ts  # or whatever route file you modified
git commit -m "feat(api): add GET /sessions and GET /sessions/:id read-only endpoints"
```

---

## Chunk 4: Halseth Client Corrections (second-brain)

Fix all four broken endpoints in `halseth-client.ts`. These depend on Chunk 3 (Halseth must be deployed with the new `/sessions` endpoints before these work in production).

**What's broken:**
| Method | Old URL | Fix |
|--------|---------|-----|
| `getSession(id)` | `GET /sessions/${id}` (path existed but returned 404) | `GET /sessions/:id` — now works after Chunk 3 |
| `getRecentSessions(days)` | `GET /sessions?days=N` (endpoint didn't exist) | `GET /sessions?days=N` — now works after Chunk 3 |
| `getRecentDeltas(days)` | `GET /deltas?days=N` (`days` param silently ignored) | `GET /deltas?limit=200`, filter client-side by date |
| `getHandover(id)` | `GET /handover/${id}` (wrong path, doesn't exist) | `GET /handovers`, filter client-side by session_id |

---

### Task 10: Rewrite HalsethClient with Correct Endpoints

**Files:**
- Modify: `src/clients/halseth-client.ts`
- Modify: `src/tests/halseth-client.test.ts`

- [ ] **Step 1: Add tests for the corrected methods**

Add to `src/tests/halseth-client.test.ts`:

```typescript
it("getSession calls /sessions/:id with encoded id", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: "abc123", front_state: "drevan" }),
  });
  vi.stubGlobal("fetch", mockFetch);

  await client.getSession("abc123");

  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining("/sessions/abc123"),
    expect.objectContaining({ signal: expect.anything() }),
  );
});

it("getRecentSessions calls /sessions?days=N", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  });
  vi.stubGlobal("fetch", mockFetch);

  await client.getRecentSessions(7);

  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining("/sessions?days=7"),
    expect.anything(),
  );
});

it("getRecentDeltas filters by date client-side", async () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [
      { id: "1", created_at: now, delta_text: "recent" },
      { id: "2", created_at: old, delta_text: "old" },
    ],
  });
  vi.stubGlobal("fetch", mockFetch);

  const result = await client.getRecentDeltas(7);
  expect(result).toHaveLength(1);
  expect(result[0].id).toBe("1");
});
```

- [ ] **Step 2: Run — verify they fail**

```bash
cd C:\dev\nullsafe-second-brain
npm test -- halseth-client
```
Expected: New tests fail.

- [ ] **Step 3: Rewrite halseth-client.ts with corrected endpoints**

```typescript
interface HalsethClientOptions {
  url: string;
  secret: string;
}

export class HalsethClient {
  constructor(private options: HalsethClientOptions) {}

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.options.url}${path}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "Authorization": `Bearer ${this.options.secret}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`Halseth ${path} → ${response.status} ${response.statusText}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  // Fetch a single session by id.
  // Requires GET /sessions/:id endpoint (added to halseth 2026-03-13).
  async getSession(id: string): Promise<Record<string, unknown>> {
    return this.get(`/sessions/${encodeURIComponent(id)}`);
  }

  // Fetch sessions from the last N days.
  // Requires GET /sessions?days=N endpoint (added to halseth 2026-03-13).
  async getRecentSessions(days = 7): Promise<Record<string, unknown>[]> {
    return this.get(`/sessions?days=${days}`);
  }

  // Fetch relational deltas from the last N days.
  // GET /deltas does not accept a ?days= param — fetches a large batch
  // and filters client-side by created_at.
  async getRecentDeltas(days = 7): Promise<Record<string, unknown>[]> {
    const all = await this.get<Record<string, unknown>[]>(`/deltas?limit=200`);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return all.filter(d => {
      const ts = d.created_at as string | undefined;
      return ts ? new Date(ts) >= cutoff : false;
    });
  }

  // Fetch a handover by session_id.
  // GET /handovers returns a list; we find the matching one client-side.
  async getHandover(sessionId: string): Promise<Record<string, unknown> | null> {
    const all = await this.get<Record<string, unknown>[]>(`/handovers?limit=100`);
    return all.find(h => h.session_id === sessionId) ?? null;
  }

  async getRoutines(date?: string): Promise<Record<string, unknown>[]> {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format: "${date}" — expected YYYY-MM-DD`);
    }
    return this.get(`/routines${date ? `?date=${date}` : ""}`);
  }
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test -- halseth-client
```
Expected: All pass.

- [ ] **Step 5: Build**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/clients/halseth-client.ts src/tests/halseth-client.test.ts
git commit -m "fix(halseth-client): correct all broken endpoints, add date filter for deltas (B1, B2, B3, V-M1)"
```

---

### Task 11: Verify Drevan's Tools Work End-to-End

- [ ] **Step 1: Deploy second-brain to VPS**

```bash
# On VPS:
cd ~/nullsafe-second-brain
git pull
npm install
npm run build
sudo systemctl restart second-brain
sudo systemctl status second-brain
```
Expected: `active (running)`.

- [ ] **Step 2: Test sb_run_patterns from Claude.ai**

Ask Claude to call `sb_run_patterns`. Expected: tool succeeds and returns `{ path: "...patterns-....md" }`. File should appear in Obsidian.

- [ ] **Step 3: Test sb_synthesize_session with a real session ID**

If a session ID is known, call `sb_synthesize_session` with it. Expected: summary file written to vault.

---

## Chunk 5: Data Protection (second-brain)

---

### Task 12: Escape Halseth Data in Synthesis Tool

**Files:**
- Modify: `src/tools/synthesis.ts`

This prevents prompt injection: if Halseth is ever compromised or a field contains adversarial markdown, it won't flow into the vault and back into Claude's context.

- [ ] **Step 1: Add escapeMd helper and apply it**

Replace the entire `formatSessionNote` function in `src/tools/synthesis.ts`:

```typescript
// Escape markdown special characters and strip newlines from external data.
// Prevents prompt injection via Halseth → vault → RAG → Claude context.
function escapeMd(value: unknown): string {
  return String(value ?? "unknown")
    .replace(/[\\`*_{}[\]()#+\-!|]/g, "\\$&")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);
}

function formatSessionNote(session: Record<string, unknown>): string {
  return [
    `# Session Summary — ${escapeMd(session.id)}`,
    ``,
    `**Front:** ${escapeMd(session.front_state)}`,
    `**Frequency:** ${escapeMd(session.emotional_frequency)}`,
    `**Anchor:** ${escapeMd(session.active_anchor)}`,
    `**Facet:** ${escapeMd(session.facet)}`,
    ``,
    `## Notes`,
    escapeMd(session.notes),
  ].join("\n");
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/synthesis.ts
git commit -m "fix(security): escape Halseth session data in vault markdown (H1, ASI06)"
```

---

### Task 13: OAuth — redirect_uri Validation + Reject Refresh Tokens + Client Cap

**Files:**
- Modify: `src/oauth-provider.ts`

Three small fixes in one file.

- [ ] **Step 1: Fix authorize() to validate redirectUri**

In the `authorize()` method, add the validation before the redirect:

```typescript
async authorize(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  res: Response,
): Promise<void> {
  // Validate redirect_uri against registered URIs (RFC 6749 §10.6)
  const registered = client.redirect_uris ?? [];
  if (!registered.includes(params.redirectUri)) {
    res.status(400).json({ error: "invalid_redirect_uri" });
    return;
  }

  // Auto-approve — this is a personal single-user server
  const authCode = randomBytes(16).toString("hex");
  // ... rest of method stays the same
```

- [ ] **Step 2: Fix exchangeRefreshToken() to reject all refresh attempts**

```typescript
async exchangeRefreshToken(
  _client: OAuthClientInformationFull,
  _refreshToken: string,
): Promise<OAuthTokens> {
  throw new Error("Refresh tokens are not supported by this server");
}
```

- [ ] **Step 3: Add client registration cap**

In the `clientsStore` getter, in `registerClient`:

```typescript
registerClient: (client) => {
  if (this.clients.size >= 50) {
    throw new Error("Client registration limit reached (50 max)");
  }
  const full: OAuthClientInformationFull = {
    ...client,
    client_id: randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  this.clients.set(full.client_id, full);
  return full;
},
```

- [ ] **Step 4: Build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/oauth-provider.ts
git commit -m "fix(security): validate redirect_uri, reject refresh tokens, cap client registrations (V-H1, V-M2, V-I1)"
```

---

## Chunk 6: Remaining Medium Items (second-brain)

---

### Task 14: Bound Search Query + Content Type Parameters

**Files:**
- Modify: `src/server.ts` (retrieval tool definitions, ~line 116-122)

- [ ] **Step 1: Add .max() to the retrieval tool schemas**

Find the `sb_search` and `sb_recall` tool registrations and update:

```typescript
// sb_search — OLD:
{ query: z.string(), limit: z.number().optional() },

// sb_search — NEW:
{ query: z.string().max(10_000), limit: z.number().int().min(1).max(100).optional() },

// sb_recall — OLD:
{ companion: z.string().nullable(), content_type: z.string().optional(), limit: z.number().optional() },

// sb_recall — NEW:
{ companion: z.string().max(64).nullable(), content_type: z.string().max(64).optional(), limit: z.number().int().min(1).max(100).optional() },
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "fix(security): bound search query and content_type params (M2)"
```

---

### Task 15: Final Build, Full Test Run, and Deploy

- [ ] **Step 1: Run all tests**

```bash
cd C:\dev\nullsafe-second-brain
npm test
```
Expected: All tests pass.

- [ ] **Step 2: Full build**

```bash
npm run build
```
Expected: No errors.

- [ ] **Step 3: Deploy to VPS**

```bash
# On VPS:
git pull
npm install
npm run build
sudo systemctl restart second-brain
sudo systemctl status second-brain
```

- [ ] **Step 4: Mark fixes as applied in CLAUDE.md**

Update the Security section in CLAUDE.md — mark all fixed items so future Claude sessions know the state. Commit that too.

```bash
git add CLAUDE.md
git commit -m "docs: mark 2026-03-13 security fixes as applied"
```

---

## What This Plan Does NOT Fix (deferred)

These remain open in CLAUDE.md for future work:

| ID | Why deferred |
|----|-------------|
| H2 — Zod validation on HTTP responses | High effort, low immediate risk; defer to dedicated task |
| H4 — Per-client OAuth tokens | Significant OAuth refactor; current model is acceptable for single-user |
| M1 — Hardcoded OAuth domain | Minor; requires config schema addition, no security urgency |
| M3 — Vector search O(n) | Performance not security; no current scale problem |
| M6 — CouchDB Base64 creds in memory | Acceptable for current deployment; document core dump policy |
| L4 — Auth code challenge rate limiting | Extremely low risk with PKCE + 5min window |
| L5 — SQLite unencrypted | Document encrypted volume; no code fix needed |
| V-L2 — trust proxy enforcement | Documentation only; UFW already handles this |
