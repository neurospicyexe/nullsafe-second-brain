import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import type { SecondBrainConfig } from "./config.js";
import { FilesystemAdapter } from "./adapters/filesystem-adapter.js";
import { CouchDBAdapter } from "./adapters/couchdb-adapter.js";
import { VectorStore } from "./store/vector-store.js";
import { OpenAIEmbedder } from "./embeddings/openai-embedder.js";
import { Indexer } from "./indexer.js";
import { RouteResolver } from "./router.js";
import { HalsethClient } from "./clients/halseth-client.js";
import { PluralClient } from "./clients/plural-client.js";
import { buildCaptureTools } from "./tools/capture.js";
import { buildRetrievalTools } from "./tools/retrieval.js";
import { buildSynthesisTools } from "./tools/synthesis.js";
import { buildSystemTools } from "./tools/system.js";

const MAX_CONTENT_LENGTH = 1_000_000; // ~1 MB of text — change freely

export function createServer(config: SecondBrainConfig) {
  // Guard unimplemented adapters/providers
  if (config.vault.adapter === "obsidian-rest") {
    throw new Error('ObsidianRESTAdapter is not yet implemented. Set vault.adapter to "filesystem".');
  }
  if (config.embeddings.provider === "ollama") {
    throw new Error('OllamaEmbedder is not yet implemented. Set embeddings.provider to "openai".');
  }

  const adapter = config.couchdb
    ? new CouchDBAdapter(config.couchdb)
    : new FilesystemAdapter(config.vault.path);

  const dbDir = join(homedir(), ".nullsafe-second-brain");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "vector-store.db");

  const store = new VectorStore(dbPath);
  store.initialize();

  const embedder = new OpenAIEmbedder({
    model: config.embeddings.model,
    apiKey: config.embeddings.api_key ?? "",
  });

  const indexer = new Indexer(adapter, embedder, store);
  const resolver = new RouteResolver(config.routing);
  const halseth = new HalsethClient(config.halseth);
  const plural = new PluralClient({ enabled: config.plural.enabled, url: config.plural.mcp_url });

  const heartSummaryPath = config.patterns.hearth_summary_path ?? "_recent-patterns.md";

  const sessionDestination =
    config.routing.find(r => r.type === "session_summary")?.destination ??
    config.routing.find(r => r.type === "observation")?.destination ??
    "raziel/";

  const capture = buildCaptureTools(indexer, resolver);
  const retrieval = buildRetrievalTools(store, embedder);
  const synthesis = buildSynthesisTools(
    indexer,
    halseth,
    sessionDestination,
    heartSummaryPath,
  );
  const system = buildSystemTools(store, indexer, adapter);

  function makeMcpServer() {
    const server = new McpServer({ name: "nullsafe-second-brain", version: "0.1.0" });
    const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

    // Capture tools
    server.tool("sb_save_document",
      { content: z.string().max(MAX_CONTENT_LENGTH), path: z.string().optional(), companion: z.string().optional(), tags: z.array(z.string()).max(50).optional() },
      (args) => capture.sb_save_document(args).then(ok));

    server.tool("sb_save_note",
      { content: z.string().max(MAX_CONTENT_LENGTH), path: z.string().optional(), companion: z.string().optional(), tags: z.array(z.string()).max(50).optional() },
      (args) => capture.sb_save_note(args).then(ok));

    server.tool("sb_save_study",
      { content: z.string().max(MAX_CONTENT_LENGTH), subject: z.string().optional(), tags: z.array(z.string()).max(50).optional() },
      (args) => capture.sb_save_study(args).then(ok));

    server.tool("sb_log_observation",
      { content: z.string().max(MAX_CONTENT_LENGTH), tags: z.array(z.string()).max(50).optional() },
      (args) => capture.sb_log_observation(args).then(ok));

    // Synthesis tools
    server.tool("sb_synthesize_session",
      { session_id: z.string() },
      (args) => synthesis.sb_synthesize_session(args).then(ok));

    server.tool("sb_run_patterns",
      {},
      () => synthesis.sb_run_patterns().then(ok));

    server.tool("sb_write_pattern_summary",
      {},
      () => synthesis.sb_write_pattern_summary().then(ok));

    // Retrieval tools
    server.tool("sb_search",
      { query: z.string(), limit: z.number().optional() },
      (args) => retrieval.sb_search(args).then(ok));

    server.tool("sb_recall",
      { companion: z.string().nullable(), content_type: z.string().optional(), limit: z.number().optional() },
      (args) => retrieval.sb_recall(args).then(ok));

    server.tool("sb_recent_patterns",
      {},
      () => retrieval.sb_recent_patterns({ vaultAdapter: adapter, summaryPath: heartSummaryPath }).then(ok));

    // System tools
    server.tool("sb_status",
      {},
      () => system.sb_status().then(ok));

    server.tool("sb_reindex_note",
      { path: z.string() },
      (args) => system.sb_reindex_note(args).then(ok));

    server.tool("sb_index_rebuild",
      { paths: z.array(z.string()) },
      (args) => system.sb_index_rebuild(args).then(ok));

    server.tool("sb_read",
      { path: z.string() },
      (args) => system.sb_read(args).then(ok));

    server.tool("sb_list",
      { path: z.string().optional() },
      (args) => system.sb_list(args).then(ok));

    server.tool("sb_move",
      { from: z.string(), to: z.string() },
      (args) => system.sb_move(args).then(ok));

    return server;
  }

  return { makeMcpServer, synthesis, adapter, store };
}
