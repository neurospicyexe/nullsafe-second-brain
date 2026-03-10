import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { setupTriggers } from "./triggers.js";
import { checkApiKey } from "./http-auth.js";

const config = loadConfig();

if (!config.http) {
  throw new Error('HTTP transport requires an "http" block in second-brain.config.json (port + api_key).');
}

const { server, synthesis } = createServer(config);
setupTriggers(config, synthesis);

const { port, api_key } = config.http;

const app = express();
app.use(express.json());

// Auth middleware — runs before all /mcp routes
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
