import express from "express";
import cors from "cors";
import { createServer as createHttpServer } from "http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { randomUUID } from "crypto";
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
app.set("trust proxy", 1); // trust Caddy's X-Forwarded-For

// Enable CORS before auth
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// OAuth endpoints — must be installed at root
app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl, resourceServerUrl }));

// Bearer auth guard for MCP endpoint
app.use("/mcp", requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }));

// Session registry for stateful transport
const sessions = new Map<string, SSEServerTransport>();

// GET /mcp — Initialize SSE stream
app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/mcp/message", res);
  await makeMcpServer().connect(transport);

  sessions.set(transport.sessionId, transport);
  transport.onclose = () => sessions.delete(transport.sessionId);
});

// POST /mcp/message — Handle incoming RPC messages
app.post("/mcp/message", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid sessionId parameter" });
    return;
  }

  const transport = sessions.get(sessionId)!;
  await transport.handlePostMessage(req, res, req.body);
});

// DELETE /mcp — Clean up session (optional, but good for active cleanup)
app.delete("/mcp", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId)!.close();
    sessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

const httpServer = createHttpServer(app);
httpServer.listen(port, "127.0.0.1", () => {
  console.error(`second-brain HTTP MCP server listening on 127.0.0.1:${port}`);
});
