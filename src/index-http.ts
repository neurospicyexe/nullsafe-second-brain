import express from "express";
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

const config = loadConfig();

if (!config.http) {
  throw new Error('HTTP transport requires an "http" block in second-brain.config.json (port + api_key).');
}

const { makeMcpServer, synthesis } = createServer(config);
setupTriggers(config, synthesis);

const { port, api_key } = config.http;

const issuerUrl = new URL("https://mcp.softcrashentity.com");
const resourceServerUrl = new URL("https://mcp.softcrashentity.com/mcp");
const resourceMetadataUrl = `https://mcp.softcrashentity.com/.well-known/oauth-protected-resource/mcp`;

const oauthProvider = new SingleUserOAuthProvider(api_key);

const app = express();
app.set("trust proxy", 1);

// CORS must be first — handles OPTIONS preflight before auth runs
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// OAuth discovery + token endpoints — must be at app root before any guards
app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl, resourceServerUrl }));

// Bearer auth guard on all /mcp routes
app.use("/mcp", requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }));

// Session registry: Mcp-Session-Id header value → transport instance
const transports = new Map<string, StreamableHTTPServerTransport>();

// Single handler for all HTTP verbs on /mcp (POST, GET, DELETE)
const mcpHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — route to existing transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      // New session — create transport, wire MCP server, handle initialize
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      await makeMcpServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Unknown request — no session, not an initialize
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Missing or invalid Mcp-Session-Id" },
      id: null,
    });
  } catch (err) {
    console.error("MCP handler error:", err);
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

const httpServer = createHttpServer(app);
httpServer.listen(port, "127.0.0.1", () => {
  console.error(`second-brain HTTP MCP server listening on 127.0.0.1:${port}`);
});
