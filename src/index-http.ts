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
import { createServer } from "./server.js";
import { setupTriggers } from "./triggers.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

// ── Startup ──────────────────────────────────────────────────────────────────

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error("[startup] Failed to load config:", err);
  process.exit(1);
}

if (!config.http) {
  console.error('[startup] HTTP transport requires an "http" block in second-brain.config.json (port + api_key).');
  process.exit(1);
}

let makeMcpServer: ReturnType<typeof createServer>["makeMcpServer"];
let synthesis: ReturnType<typeof createServer>["synthesis"];
try {
  ({ makeMcpServer, synthesis } = createServer(config));
} catch (err) {
  console.error("[startup] Failed to create server:", err);
  process.exit(1);
}

try {
  setupTriggers(config, synthesis);
} catch (err) {
  console.error("[startup] Failed to set up triggers (non-fatal):", err);
}

const { port, api_key } = config.http;

// Log what we initialized — no secrets, just shape
console.error("[startup] Configuration loaded:");
console.error(`  adapter  : ${config.couchdb ? "couchdb" : "filesystem"}`);
console.error(`  companions: ${config.companions.map(c => c.id).join(", ")}`);
console.error(`  embeddings: ${config.embeddings.provider} / ${config.embeddings.model} / key=${config.embeddings.api_key ? "set" : "MISSING"}`);
console.error(`  halseth  : ${config.halseth.url} / secret=${config.halseth.secret ? "set" : "MISSING"}`);
console.error(`  port     : ${port}`);

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

// Health check — unauthenticated, used for uptime monitoring
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "nullsafe-second-brain", timestamp: new Date().toISOString() });
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

    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          console.error(`[mcp] Session initialized: ${sid} (active: ${transports.size})`);
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

    console.error(`[mcp] 400 — sessionId=${sessionId ?? "none"} known=${[...transports.keys()].map(k => k.slice(0, 8)).join(",")}`);
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Missing or invalid Mcp-Session-Id" },
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
  console.error(`[startup] second-brain listening on 127.0.0.1:${port}`);
});

// ── Process-level safety nets ─────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception:", err);
  // Don't exit — systemd will restart if needed; better to stay up for other sessions
});

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled promise rejection:", reason);
});
