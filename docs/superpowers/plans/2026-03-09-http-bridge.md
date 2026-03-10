# HTTP Bridge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose second-brain as a remote MCP server over HTTPS so Claude.ai can connect to it from any device.

**Architecture:** Add a new `src/index-http.ts` entry point that wraps the existing `createServer()` with an Express HTTP server using `StreamableHTTPServerTransport`. API key auth guards the `/mcp` endpoint. Caddy proxies `https://mcp.softcrashentity.com` → `localhost:3001`. The VPS systemd service runs the HTTP entry point. The stdio `index.ts` entry point is unchanged — Claude Desktop continues to work locally.

**Tech Stack:** Express 5 (transitive dep via MCP SDK), `@modelcontextprotocol/sdk` StreamableHTTPServerTransport, CouchDB REST API (native fetch), Caddy reverse proxy, systemd, vitest for tests

**Stack context:** This is Layer 2 (second-brain) in the three-layer Nullsafe stack. Halseth is Layer 1 (relational record). Plural is Layer 3 (front state). Second-brain is the searchable knowledge library — the shelf, not the journal. Everything second-brain writes must be visible in Obsidian on all devices, which requires writing through CouchDB in LiveSync's format rather than to the filesystem.

---

## Chunk 0: CouchDB Adapter

Replace the filesystem write path on VPS with a CouchDB adapter that writes directly to CouchDB in LiveSync's document format, making vault writes instantly visible on all synced devices.

**LiveSync document format (reverse-engineered from live DB):**
- **Metadata doc**: `{ _id: "path/to/file.md", path, children: ["h:chunkid"], ctime, mtime, size, type: "plain", eden: {}, deleted: false }`
- **Chunk doc**: `{ _id: "h:<randomid>", data: base64(content), type: "leaf" }`
- Small files = single chunk. Multiple chunks for large files (chunk at ~500KB boundaries).
- `deleted: true` on metadata doc = soft delete (LiveSync convention).
- `_id` is the vault-relative path, no leading slash.

### Task 0a: Add CouchDB config block

**Files:**
- Modify: `src/config.ts`
- Modify: `second-brain.config.example.json`
- Modify: `src/tests/config.test.ts`

- [ ] **Step 1: Add failing test for couchdb config**

Add to `src/tests/config.test.ts`:

```typescript
it("loads config with couchdb block", () => {
  writeConfig({ ...baseConfig, couchdb: { url: "http://localhost:5984", db: "obsidian-vault", username: "admin", password: "pass" } });
  const config = loadConfig(tmpPath);
  expect(config.couchdb?.db).toBe("obsidian-vault");
  cleanup();
});

it("config with couchdb block but missing url fails", () => {
  writeConfig({ ...baseConfig, couchdb: { db: "obsidian-vault", username: "admin", password: "pass" } });
  expect(() => loadConfig(tmpPath)).toThrow();
  cleanup();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test src/tests/config.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add couchdb schema to config.ts**

In `src/config.ts`, add to `configSchema` after the `http` block:

```typescript
  couchdb: z.object({
    url: z.string().url(),
    db: z.string().min(1),
    username: z.string(),
    password: z.string(),
  }).optional(),
```

- [ ] **Step 4: Add couchdb block to example config**

In `second-brain.config.example.json`, add after `http`:

```json
  "couchdb": { "url": "http://localhost:5984", "db": "obsidian-vault", "username": "admin", "password": "" }
```

- [ ] **Step 5: Run tests, then build**

```bash
npm test src/tests/config.test.ts && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts second-brain.config.example.json src/tests/config.test.ts
git commit -m "feat: add optional couchdb config block"
```

---

### Task 0b: Create CouchDBAdapter

**Files:**
- Create: `src/adapters/couchdb-adapter.ts`
- Modify: `src/adapters/vault-adapter.ts` (no changes needed — interface already covers all operations)
- Create: `src/tests/couchdb-adapter.test.ts`
- Modify: `src/server.ts` (select adapter based on config)

- [ ] **Step 1: Write failing tests**

Create `src/tests/couchdb-adapter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CouchDBAdapter } from "../adapters/couchdb-adapter.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const adapter = new CouchDBAdapter({
  url: "http://localhost:5984",
  db: "test-vault",
  username: "admin",
  password: "pass",
});

beforeEach(() => { mockFetch.mockReset(); });

describe("CouchDBAdapter.exists", () => {
  it("returns true when metadata doc exists and is not deleted", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "foo.md", deleted: false, children: [] }),
    });
    expect(await adapter.exists("foo.md")).toBe(true);
  });

  it("returns false when doc has deleted: true", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "foo.md", deleted: true, children: [] }),
    });
    expect(await adapter.exists("foo.md")).toBe(false);
  });

  it("returns false when doc not found (404)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await adapter.exists("foo.md")).toBe(false);
  });
});

describe("CouchDBAdapter.write", () => {
  it("PUTs a chunk doc and metadata doc", async () => {
    // chunk PUT
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, rev: "1-abc" }) });
    // metadata GET (to get existing _rev)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    // metadata PUT
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await adapter.write({ path: "test.md", content: "hello" });

    // Should have made 3 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Metadata PUT should include path and children
    const metaPutCall = mockFetch.mock.calls[2];
    const metaBody = JSON.parse(metaPutCall[1].body);
    expect(metaBody.path).toBe("test.md");
    expect(metaBody.children).toHaveLength(1);
    expect(metaBody.deleted).toBe(false);
  });
});

describe("CouchDBAdapter.read", () => {
  it("reads and decodes base64 chunk content", async () => {
    const content = "hello world";
    const b64 = Buffer.from(content).toString("base64");
    // metadata GET
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "test.md", children: ["h:abc123"], deleted: false }),
    });
    // chunk GET
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ _id: "h:abc123", data: b64, type: "leaf" }),
    });

    const result = await adapter.read("test.md");
    expect(result).toBe(content);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test src/tests/couchdb-adapter.test.ts
```

Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Create src/adapters/couchdb-adapter.ts**

```typescript
import { randomBytes } from "crypto";
import type { VaultAdapter, VaultWriteOptions } from "./vault-adapter.js";

interface CouchDBConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

const CHUNK_SIZE = 500_000; // 500KB — split files larger than this

export class CouchDBAdapter implements VaultAdapter {
  private baseUrl: string;
  private authHeader: string;

  constructor(private config: CouchDBConfig) {
    this.baseUrl = `${config.url}/${config.db}`;
    this.authHeader = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: this.authHeader, "Content-Type": "application/json", ...extra };
  }

  private chunkId(): string {
    return "h:" + randomBytes(8).toString("hex");
  }

  private async getDoc(id: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CouchDB GET ${id} failed: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async putDoc(id: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CouchDB PUT ${id} failed: ${res.status}`);
  }

  async write({ path, content, overwrite = true }: VaultWriteOptions): Promise<void> {
    // Check overwrite
    if (!overwrite) {
      if (await this.exists(path)) return;
    }

    const now = Date.now();
    const buf = Buffer.from(content, "utf-8");

    // Split into chunks
    const chunkIds: string[] = [];
    for (let i = 0; i < buf.length || chunkIds.length === 0; i += CHUNK_SIZE) {
      const slice = buf.slice(i, i + CHUNK_SIZE);
      const id = this.chunkId();
      await this.putDoc(id, { _id: id, data: slice.toString("base64"), type: "leaf" });
      chunkIds.push(id);
    }

    // Get existing rev for metadata doc (needed for updates)
    const existing = await this.getDoc(path);
    const metaDoc: Record<string, unknown> = {
      _id: path,
      path,
      children: chunkIds,
      ctime: (existing?.ctime as number) ?? now,
      mtime: now,
      size: buf.length,
      type: "plain",
      eden: {},
      deleted: false,
    };
    if (existing?._rev) metaDoc._rev = existing._rev;

    await this.putDoc(path, metaDoc);
  }

  async read(path: string): Promise<string> {
    const meta = await this.getDoc(path);
    if (!meta || meta.deleted) throw new Error(`File not found: ${path}`);

    const children = (meta.children as string[]) ?? [];
    const parts: string[] = [];
    for (const chunkId of children) {
      const chunk = await this.getDoc(chunkId);
      if (!chunk) throw new Error(`Missing chunk ${chunkId} for ${path}`);
      const data = chunk.data as string;
      // Try base64 decode; fall back to raw if it fails
      try {
        parts.push(Buffer.from(data, "base64").toString("utf-8"));
      } catch {
        parts.push(data);
      }
    }
    return parts.join("");
  }

  async exists(path: string): Promise<boolean> {
    const doc = await this.getDoc(path);
    return doc !== null && !doc.deleted;
  }

  async list(dirPath = ""): Promise<string[]> {
    const prefix = dirPath ? (dirPath.endsWith("/") ? dirPath : dirPath + "/") : "";
    const url = `${this.baseUrl}/_all_docs?include_docs=true`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`CouchDB _all_docs failed: ${res.status}`);
    const result = await res.json() as { rows: Array<{ id: string; doc: Record<string, unknown> }> };
    return result.rows
      .filter(r =>
        !r.id.startsWith("h:") &&
        !r.id.startsWith("_") &&
        r.id !== "obsydian_livesync_version" &&
        !r.doc.deleted &&
        r.doc.type !== "versioninfo" &&
        (prefix === "" || r.id.startsWith(prefix))
      )
      .map(r => r.id);
  }

  async move(from: string, to: string): Promise<void> {
    const meta = await this.getDoc(from);
    if (!meta || meta.deleted) throw new Error(`File not found: ${from}`);

    // Write content to new path
    const content = await this.read(from);
    await this.write({ path: to, content });

    // Soft-delete old path
    await this.putDoc(from, { ...meta, deleted: true, mtime: Date.now() });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test src/tests/couchdb-adapter.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Wire adapter selection into server.ts**

In `src/server.ts`, after the adapter guard block, replace:

```typescript
  const adapter = new FilesystemAdapter(config.vault.path);
```

With:

```typescript
  const adapter = config.couchdb
    ? new CouchDBAdapter(config.couchdb)
    : new FilesystemAdapter(config.vault.path);
```

Add the import at the top:

```typescript
import { CouchDBAdapter } from "./adapters/couchdb-adapter.js";
```

- [ ] **Step 6: Build**

```bash
npm run build
```

- [ ] **Step 7: Run all tests**

```bash
npm test
```

- [ ] **Step 8: Commit**

```bash
git add src/adapters/couchdb-adapter.ts src/tests/couchdb-adapter.test.ts src/server.ts
git commit -m "feat: add CouchDBAdapter for direct LiveSync-compatible vault writes"
```

---

## Chunk 1: Config + Dependencies

### Task 1: Add express as direct dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add express and @types/express to package.json**

```bash
npm install express
npm install --save-dev @types/express
```

- [ ] **Step 2: Verify build still passes**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add express as direct dependency"
```

---

### Task 2: Add HTTP config block

**Files:**
- Modify: `src/config.ts`
- Modify: `second-brain.config.example.json`
- Create: `src/tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tests/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const tmpPath = join(process.cwd(), "test-config-tmp.json");

function writeConfig(obj: unknown) {
  writeFileSync(tmpPath, JSON.stringify(obj), "utf-8");
}

function cleanup() {
  try { unlinkSync(tmpPath); } catch {}
}

const baseConfig = {
  vault: { adapter: "filesystem", path: "/tmp/vault" },
  halseth: { url: "https://example.workers.dev", secret: "s" },
  plural: { enabled: false },
  companions: [{ id: "a", role: "companion", vault_folder: "a/" }],
  triggers: {
    scheduled: { enabled: false, cron: "0 22 * * *" },
    on_demand: true,
    event_driven: { enabled: false, on_session_close: false, on_handover: false },
  },
  routing: [],
  patterns: { enabled: false, hearth_summary: false },
  embeddings: { provider: "openai", model: "text-embedding-3-small", api_key: "k" },
};

describe("loadConfig - http block", () => {
  it("loads config without http block (http is optional)", () => {
    writeConfig(baseConfig);
    const config = loadConfig(tmpPath);
    expect(config.http).toBeUndefined();
    cleanup();
  });

  it("loads config with http block", () => {
    writeConfig({ ...baseConfig, http: { port: 3001, api_key: "secret" } });
    const config = loadConfig(tmpPath);
    expect(config.http?.port).toBe(3001);
    expect(config.http?.api_key).toBe("secret");
    cleanup();
  });

  it("rejects http block with invalid port", () => {
    writeConfig({ ...baseConfig, http: { port: "not-a-number", api_key: "secret" } });
    expect(() => loadConfig(tmpPath)).toThrow();
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test src/tests/config.test.ts
```

Expected: FAIL — "http block" tests fail because schema doesn't know about `http` yet.

- [ ] **Step 3: Add http block to config schema**

In `src/config.ts`, add to `configSchema`:

```typescript
  http: z.object({
    port: z.number().int().min(1024).max(65535),
    api_key: z.string().min(1),
  }).optional(),
```

Add it after the `embeddings` block, before the closing `});` of `configSchema`.

- [ ] **Step 4: Update example config**

In `second-brain.config.example.json`, add after the `embeddings` block:

```json
  "http": { "port": 3001, "api_key": "replace-with-a-strong-random-secret" }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test src/tests/config.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 6: Verify full build passes**

```bash
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/config.ts second-brain.config.example.json src/tests/config.test.ts
git commit -m "feat: add optional http config block for remote MCP transport"
```

---

## Chunk 2: HTTP Entry Point

### Task 3: Create auth middleware utility

**Files:**
- Create: `src/http-auth.ts`
- Create: `src/tests/http-auth.test.ts`

This is extracted into its own file so it can be tested independently of the Express wiring.

- [ ] **Step 1: Write the failing test**

Create `src/tests/http-auth.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkApiKey } from "../http-auth.js";

describe("checkApiKey", () => {
  it("returns true when Authorization header matches", () => {
    expect(checkApiKey("Bearer mysecret", "mysecret")).toBe(true);
  });

  it("returns false when header is wrong", () => {
    expect(checkApiKey("Bearer wrong", "mysecret")).toBe(false);
  });

  it("returns false when header is missing", () => {
    expect(checkApiKey(undefined, "mysecret")).toBe(false);
  });

  it("returns false when header has no Bearer prefix", () => {
    expect(checkApiKey("mysecret", "mysecret")).toBe(false);
  });

  it("returns true when api_key is empty string (auth disabled)", () => {
    // Empty api_key = auth disabled, allow all
    expect(checkApiKey(undefined, "")).toBe(true);
    expect(checkApiKey("anything", "")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test src/tests/http-auth.test.ts
```

Expected: FAIL — `http-auth.ts` doesn't exist yet.

- [ ] **Step 3: Create src/http-auth.ts**

```typescript
/**
 * Returns true if the request is authorized.
 * If api_key is empty, auth is disabled and all requests pass.
 */
export function checkApiKey(authHeader: string | undefined, apiKey: string): boolean {
  if (!apiKey) return true;
  return authHeader === `Bearer ${apiKey}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test src/tests/http-auth.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http-auth.ts src/tests/http-auth.test.ts
git commit -m "feat: add api key auth utility for HTTP transport"
```

---

### Task 4: Create src/index-http.ts

**Files:**
- Create: `src/index-http.ts`
- Modify: `package.json` (add scripts)

- [ ] **Step 1: Create src/index-http.ts**

```typescript
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { setupTriggers } from "./triggers.js";
import { checkApiKey } from "./http-auth.js";

const config = loadConfig();

if (!config.http) {
  throw new Error('HTTP transport requires "http" block in second-brain.config.json (port + api_key).');
}

const { server, synthesis } = createServer(config);
setupTriggers(config, synthesis);

const { port, api_key } = config.http;

const app = express();
app.use(express.json());

// Auth middleware
app.use("/mcp", (req, res, next) => {
  if (!checkApiKey(req.headers.authorization, api_key)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// Session registry for stateful transport
const sessions = new Map<string, StreamableHTTPServerTransport>();

// POST /mcp — initialize or continue a session
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId)!;
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    if (transport.sessionId) {
      sessions.set(transport.sessionId, transport);
      transport.onclose = () => sessions.delete(transport.sessionId!);
    }
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE stream for server-initiated messages
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid mcp-session-id" });
    return;
  }
  await sessions.get(sessionId)!.handleRequest(req, res);
});

// DELETE /mcp — clean up session
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId)!.close();
    sessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

app.listen(port, "127.0.0.1", () => {
  console.error(`second-brain HTTP MCP server listening on 127.0.0.1:${port}`);
});
```

- [ ] **Step 2: Add scripts to package.json**

Add to the `scripts` block:

```json
"dev:http": "tsx src/index-http.ts",
"start:http": "node dist/index-http.js"
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: clean build. Check that `dist/index-http.js` was created.

- [ ] **Step 4: Run tests to make sure nothing broke**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/index-http.ts package.json
git commit -m "feat: add HTTP/SSE MCP transport entry point for remote access"
```

---

## Chunk 3: VPS Deployment

### Task 5: Push and deploy to VPS

- [ ] **Step 1: Push all commits**

```bash
git push
```

- [ ] **Step 2: SSH to VPS and clone the repo**

```bash
cd ~
git clone https://github.com/neurospicyexe/nullsafe-second-brain.git
cd nullsafe-second-brain
```

- [ ] **Step 3: Install dependencies and build**

```bash
npm install
npm run build
```

- [ ] **Step 4: Create second-brain.config.json on VPS**

```bash
cp second-brain.config.example.json second-brain.config.json
chmod 600 second-brain.config.json
nano second-brain.config.json
```

Fill in:
- `vault.path` — path where LiveSync materializes vault files (TBD — depends on where you want files to land on VPS, e.g. `/home/nullsafe/vault`)
- `halseth.url` and `halseth.secret`
- `embeddings.api_key`
- `http.port`: `3001`
- `http.api_key`: a strong random secret (generate with `openssl rand -hex 32`)

- [ ] **Step 5: Update Caddyfile**

```bash
sudo nano /etc/caddy/Caddyfile
```

Add a new block (keep the existing `db.softcrashentity.com` block):

```
mcp.softcrashentity.com {
    reverse_proxy localhost:3001
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

- [ ] **Step 6: Create systemd service**

```bash
sudo nano /etc/systemd/system/second-brain.service
```

```ini
[Unit]
Description=Nullsafe Second Brain MCP Server (HTTP)
After=network.target

[Service]
Type=simple
User=nullsafe
WorkingDirectory=/home/nullsafe/nullsafe-second-brain
ExecStart=/home/nullsafe/.nvm/versions/node/NODEVERSION/bin/node dist/index-http.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Note:** Replace `NODEVERSION` with the output of `node --version` (e.g. `v22.13.1`).

Or use the nvm shim path: find the actual node binary with `which node` after activating nvm.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now second-brain
sudo systemctl status second-brain
```

- [ ] **Step 7: Verify the MCP endpoint is reachable**

From your local machine:

```bash
curl -X POST https://mcp.softcrashentity.com/mcp \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}},"id":1}'
```

Expected: JSON response with `"result"` containing server capabilities.

- [ ] **Step 8: Update CLAUDE.md checklist**

Mark VPS deployment items as complete.

---

## Chunk 4: Connect Claude.ai

### Task 6: Add remote MCP in Claude.ai

- [ ] **Step 1: Open Claude.ai → Settings → Integrations (or "Connections")**

- [ ] **Step 2: Add a new MCP server**

- **Name:** `nullsafe-second-brain`
- **URL:** `https://mcp.softcrashentity.com/mcp`
- **Auth:** Bearer token → paste your `http.api_key` value

- [ ] **Step 3: Verify tools appear**

Start a new conversation in Claude.ai. The second-brain tools (`sb_save_document`, `sb_search`, etc.) should appear in the tools list.

- [ ] **Step 4: Smoke test**

Ask Claude to call `sb_status` — it should return the current index state.

---

## Notes

- **Vault path on VPS:** LiveSync materializes files where Obsidian would put them, but on the VPS there's no Obsidian. The vault path in config should be a plain directory that second-brain writes to. A separate sync step (or future work) would push those writes into CouchDB so devices see them. For now, second-brain on VPS can write to `/home/nullsafe/vault/` and that folder can be manually synced, or left as a write-only store for RAG purposes.
- **stdio still works:** `npm run dev` / `npm start` still uses `index.ts` (stdio) for Claude Desktop on Windows.
- **Session cleanup:** Sessions are in-memory only. VPS restart clears all sessions — Claude.ai reconnects automatically on next use.
