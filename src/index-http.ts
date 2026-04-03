import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer as createHttpServer } from "http";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadConfig } from "./config.js";
import { loadIngestionConfig } from "./ingestion/config.js";
import { cronHealth } from "./ingestion/cron-health.js";
import { createServer } from "./server.js";
import { setupTriggers } from "./triggers.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { semanticChunk } from "./ingestion/chunker.js";
import { wrapChunk } from "./ingestion/deepseek-wrapper.js";
import { withConcurrencyLimit } from "./ingestion/corpus.js";
import type { SourceType, IngestRecord } from "./ingestion/types.js";

// ── Startup ──────────────────────────────────────────────────────────────────

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error("[startup] Failed to load config:", err);
  process.exit(1);
}

let ingestionConfig: ReturnType<typeof loadIngestionConfig> | undefined;
try {
  ingestionConfig = loadIngestionConfig();
} catch (err) {
  console.error("[startup] Ingestion config unavailable (corpus ingest endpoint disabled):", err);
}

if (!config.http) {
  console.error('[startup] HTTP transport requires an "http" block in second-brain.config.json (port + api_key).');
  process.exit(1);
}

let makeMcpServer: ReturnType<typeof createServer>["makeMcpServer"];
let synthesis: ReturnType<typeof createServer>["synthesis"];
let store: ReturnType<typeof createServer>["store"];
let embedder: ReturnType<typeof createServer>["embedder"];
let indexer: ReturnType<typeof createServer>["indexer"];
try {
  ({ makeMcpServer, synthesis, store, embedder, indexer } = createServer(config));
} catch (err) {
  console.error("[startup] Failed to create server:", err);
  process.exit(1);
}

try {
  await setupTriggers(config, synthesis, store, embedder);
} catch (err) {
  console.error("[startup] Failed to set up triggers (non-fatal):", err);
}

const { port, api_key } = config.http;

// Log what we initialized — no secrets, just shape
console.log("[startup] Configuration loaded:");
console.log(`  adapter  : ${config.couchdb ? "couchdb" : "filesystem"}`);
console.log(`  companions: ${config.companions.map(c => c.id).join(", ")}`);
console.log(`  embeddings: ${config.embeddings.provider} / ${config.embeddings.model} / key=${config.embeddings.api_key ? "set" : "MISSING"}`);
console.log(`  halseth  : ${config.halseth.url} / secret=${config.halseth.secret ? "set" : "MISSING"}`);
console.log(`  port     : ${port}`);

const issuerUrl = new URL("https://mcp.softcrashentity.com");
const resourceServerUrl = new URL("https://mcp.softcrashentity.com/mcp");
const resourceMetadataUrl = `https://mcp.softcrashentity.com/.well-known/oauth-protected-resource/mcp`;

const oauthProvider = new SingleUserOAuthProvider(api_key);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);

// CORS must be first — handles OPTIONS preflight before auth runs
app.use(cors({
  origin: ["https://claude.ai", "https://mcp.softcrashentity.com"],
  credentials: true,
}));

// Security headers — defense-in-depth even behind Caddy proxy
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Raise body limit to 4 MB — MCP tool payloads with large content exceed the
// default 100 kb limit, causing raw-body to throw before the handler runs.
app.use(express.json({ limit: "4mb" }));

// Body-parse error handler — must be 4-param for Express to treat it as an
// error handler (not a regular route). Catches entity.too.large and bad JSON
// before they bubble up as unhandled exceptions.
app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
  if ((err as { type?: string }).type === "entity.too.large") {
    console.error("[http] Payload too large — increase body limit in index-http.ts");
    res.status(413).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Payload too large" },
      id: null,
    });
    return;
  }
  if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
    console.error("[http] Malformed JSON body:", err.message);
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: invalid JSON" },
      id: null,
    });
    return;
  }
  next(err);
});

// OAuth discovery + token endpoints — must be at app root before any guards
app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl, resourceServerUrl }));

// Health check — unauthenticated, used for uptime monitoring.
// Includes cron job status; returns 503 if any job is in error or stale.
app.get("/health", (_req, res) => {
  cronHealth.checkStale();
  const jobs = cronHealth.getAll();
  const healthy = cronHealth.isHealthy();
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "nullsafe-second-brain",
    timestamp: new Date().toISOString(),
    crons: jobs,
  });
});

// Bearer auth guard on all /mcp routes
app.use("/mcp", requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }));

// ── MCP session registry ──────────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

const mcpHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const method = String(req.body?.method ?? req.method).replace(/[\r\n]/g, " ").slice(0, 64);
    console.error(`[mcp] ${req.method} session=${sessionId?.slice(0, 8) ?? "none"} method=${method}`);

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === "POST" && isInitializeRequest(req.body)) {
      // Accept both fresh connections (no session ID) and stale session IDs from
      // clients that cached a session across a server restart. When the client
      // already has a session ID we reuse it as the generator so the response
      // echoes the same ID back — the client never notices the restart.
      const reuseId = sessionId ?? null;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: reuseId ? () => reuseId : () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          const label = reuseId ? "re-registered" : "initialized";
          console.error(`[mcp] Session ${label}: ${sid} (active: ${transports.size})`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          console.error(`[mcp] Session closed: ${sid} (active: ${transports.size})`);
        }
      };

      await makeMcpServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Unknown session ID on a non-initialize request — session is gone (restart).
    // 404 signals to the client that it should re-initialize.
    console.error(`[mcp] 404 — sessionId=${sessionId ?? "none"} known=${[...transports.keys()].map(k => k.slice(0, 8)).join(",")}`);
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found: please re-initialize" },
      id: null,
    });
  } catch (err) {
    console.error("[mcp] Handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
};

app.post("/mcp", mcpHandler);
app.get("/mcp", mcpHandler);
app.delete("/mcp", mcpHandler);

// ── Manual ingest endpoint ────────────────────────────────────────────────────

// Same bearer auth as MCP routes
app.use("/ingest", requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }));

// POST /ingest/text — index raw text into the vector store as course_material.
// Used by the NotebookLM → Second Brain seeding workflow from Claude Code.
// Body: { title: string, content: string, companion?: string, tags?: string[], replace?: boolean }
app.post("/ingest/text", async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, content, companion, tags, replace } = req.body ?? {};

    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    if (content.length > 500_000) {
      res.status(413).json({ error: "content exceeds 500KB limit" });
      return;
    }

    const slug = title.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);
    const vaultPath = `notebooklm/${slug}.md`;

    if (!replace && store.existsByPath(vaultPath)) {
      res.json({ vault_path: vaultPath, chunks_indexed: 0, message: "already indexed — pass replace:true to overwrite" });
      return;
    }

    const resolvedCompanion = typeof companion === "string" ? companion.toLowerCase().slice(0, 64) : null;
    const resolvedTags: string[] = Array.isArray(tags) ? tags.map(String).slice(0, 20) : [];

    await indexer.write({
      path: vaultPath,
      content: content.trim(),
      companion: resolvedCompanion,
      content_type: "course_material",
      tags: resolvedTags,
      overwrite: true,
    });

    const chunksIndexed = store.filterByPath(vaultPath).length;
    console.log(`[ingest] indexed ${chunksIndexed} chunks → ${vaultPath}`);
    res.json({ vault_path: vaultPath, chunks_indexed: chunksIndexed, message: "ok" });
  } catch (err) {
    console.error("[ingest] POST /ingest/text error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal error" });
    }
  }
});

// POST /ingest/corpus-file — run one or more .md files through the full DeepSeek
// semantic chunking pipeline and index into the vector store as historical_corpus.
// Body: { files: Array<{ filename: string, content: string }>, source_type?: SourceType }
// Single-file shorthand: { filename: string, content: string, source_type?: SourceType }
app.post("/ingest/corpus-file", async (req: Request, res: Response): Promise<void> => {
  if (!ingestionConfig) {
    res.status(503).json({ error: "ingestion config not available — check DEEPSEEK_API_KEY, HALSETH_URL, HALSETH_SECRET env vars" });
    return;
  }

  try {
    const body = req.body ?? {};

    // Normalise single-file and batch-file shapes into one array
    const rawFiles: Array<{ filename: unknown; content: unknown }> =
      Array.isArray(body.files) ? body.files : [{ filename: body.filename, content: body.content }];

    if (rawFiles.length === 0) {
      res.status(400).json({ error: "no files provided" });
      return;
    }
    if (rawFiles.length > 50) {
      res.status(400).json({ error: "max 50 files per request" });
      return;
    }

    const sourceType: SourceType =
      typeof body.source_type === "string" && body.source_type.length > 0
        ? (body.source_type as SourceType)
        : "historical_corpus";

    // Validate all files up-front before doing any work
    for (const f of rawFiles) {
      if (typeof f.filename !== "string" || !f.filename.trim()) {
        res.status(400).json({ error: "each file must have a non-empty filename" });
        return;
      }
      if (typeof f.content !== "string" || !f.content.trim()) {
        res.status(400).json({ error: `file "${f.filename}" has empty content` });
        return;
      }
      if (f.content.length > 500_000) {
        res.status(413).json({ error: `file "${f.filename}" exceeds 500KB limit` });
        return;
      }
    }

    // Respond immediately — Cloudflare's 100s proxy timeout kills long DeepSeek calls.
    // Processing continues in the background; dedup ensures safe re-runs.
    res.status(202).json({
      message: "accepted",
      source_type: sourceType,
      files: rawFiles.map(f => (f.filename as string).trim()),
    });

    // Background processing — intentionally not awaited
    (async () => {
      for (const f of rawFiles) {
        const filename = (f.filename as string).trim();
        let chunksIndexed = 0;
        let chunksSkipped = 0;

        try {
          const chunks = await semanticChunk(f.content as string, ingestionConfig!);
          console.log(`[ingest/corpus-file] ${filename}: ${chunks.length} chunks`);

          await withConcurrencyLimit(
            chunks.map((chunk, i) => ({ chunk, i })),
            ingestionConfig!.concurrencyLimit,
            ingestionConfig!.concurrencyDelayMs,
            async ({ chunk, i }) => {
              const vaultPath = `rag/${sourceType}/${filename}/${i}`;

              if (store.existsByPath(vaultPath)) {
                chunksSkipped++;
                return;
              }

              const record: IngestRecord = {
                id: i,
                source_type: sourceType,
                content: chunk.content,
                created_at: new Date().toISOString(),
              };

              const wrapped = await wrapChunk(record, ingestionConfig!);
              const embedding = await embedder.embed(wrapped);

              store.insert({
                vault_path: vaultPath,
                chunk_text: wrapped,
                embedding,
                companion: null,
                content_type: sourceType,
                tags: [chunk.label],
              });

              chunksIndexed++;
            }
          );
        } catch (err) {
          console.error(`[ingest/corpus-file] failed: ${filename}`, err);
          continue;
        }

        console.log(`[ingest/corpus-file] ${filename}: ${chunksIndexed} indexed, ${chunksSkipped} skipped`);
      }
      console.log(`[ingest/corpus-file] batch complete for ${rawFiles.length} files`);
    })();
  } catch (err) {
    console.error("[ingest/corpus-file] error:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

// ── HTTP server ───────────────────────────────────────────────────────────────

const httpServer = createHttpServer(app);

// Kill idle connections that hold the socket open without sending a complete
// request — guards against premature-close / half-open TCP from the client.
httpServer.setTimeout(30_000);

// Log TCP-level errors (e.g. client disconnects mid-request) without crashing.
httpServer.on("clientError", (err, socket) => {
  console.error("[http] Client error:", (err as NodeJS.ErrnoException).code ?? err.message);
  socket.destroy();
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`[startup] second-brain listening on 127.0.0.1:${port}`);
});

// ── Process-level safety nets ─────────────────────────────────────────────────

// Graceful shutdown: close the SQLite connection cleanly so in-flight WAL writes
// are flushed before systemd sends SIGKILL after TimeoutStopSec.
const shutdown = (signal: string) => {
  console.log(`[process] ${signal} received — shutting down`);
  httpServer.close(() => {
    try { store.close(); } catch {}
    process.exit(0);
  });
  // Force exit if httpServer.close() hangs (e.g., long-lived SSE connections)
  setTimeout(() => { try { store.close(); } catch {} process.exit(0); }, 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception:", err);
  // Don't exit — systemd will restart if needed; better to stay up for other sessions
});

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled promise rejection:", reason);
});
