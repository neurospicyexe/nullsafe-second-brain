import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { setupTriggers } from "./triggers.js";

const config = loadConfig();
const { makeMcpServer, synthesis, store, embedder } = createServer(config);
await setupTriggers(config, synthesis, store, embedder);
const transport = new StdioServerTransport();
await makeMcpServer().connect(transport);
