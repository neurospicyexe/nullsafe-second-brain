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
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });
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
    const run = <T>(name: string, fn: () => Promise<T>) =>
      fn().then(ok).catch((err: unknown) => { console.error(`[tool:${name}]`, err); throw err; });

    // Capture tools
    // ── Capture tools ────────────────────────────────────────────────────────
    server.tool("sb_save_document",
      "Write a permanent document into the second brain vault — use for companion memory, growth records, relationship notes, organizational knowledge, or any content that should persist long-term. Optionally scoped to a companion (drevan, cypher, gaia) via the companion param.",
      { content: z.string().max(MAX_CONTENT_LENGTH), path: z.string().max(256).optional(), companion: z.string().max(64).optional(), tags: z.array(z.string()).max(50).optional() },
      (args) => run("sb_save_document", () => capture.sb_save_document(args)));

    server.tool("sb_save_note",
      "Write a note or quick capture into the vault — use for session insights, reflections, brief thoughts, or anything the user or a companion wants to remember. Lighter than a document; good for in-the-moment captures.",
      { content: z.string().max(MAX_CONTENT_LENGTH), path: z.string().max(256).optional(), companion: z.string().max(64).optional(), tags: z.array(z.string()).max(50).optional() },
      (args) => run("sb_save_note", () => capture.sb_save_note(args)));

    server.tool("sb_save_study",
      "Save learning material, research, or study notes into the vault — use when the user is learning something new, exploring a topic, or wants to retain educational content. Organized by subject.",
      { content: z.string().max(MAX_CONTENT_LENGTH), subject: z.string().max(256).optional(), tags: z.array(z.string()).max(50).optional() },
      (args) => run("sb_save_study", () => capture.sb_save_study(args)));

    server.tool("sb_log_observation",
      "Log a timestamped observation, pattern, or behavioral note into the INBOX — use to record what you notice about the user, a companion, or the system. Always goes to INBOX, never overwrites. Good for pattern tracking, emotional notes, or quick flags.",
      { content: z.string().max(MAX_CONTENT_LENGTH), tags: z.array(z.string()).max(50).optional() },
      (args) => run("sb_log_observation", () => capture.sb_log_observation(args)));

    // ── Synthesis tools ───────────────────────────────────────────────────────
    server.tool("sb_synthesize_session",
      "Pull a Halseth session by ID and write a structured session summary note into the vault — use after a significant session closes to preserve what happened, who was front, emotional state, and anchors.",
      { session_id: z.string() },
      (args) => synthesis.sb_synthesize_session(args).then(ok));

    server.tool("sb_run_patterns",
      "Analyze recent sessions and relational deltas from Halseth (last 7 days) and write a pattern observation note to the vault — use to surface trends, growth arcs, or recurring themes across the system.",
      {},
      () => synthesis.sb_run_patterns().then(ok));

    server.tool("sb_write_pattern_summary",
      "Regenerate the hearth pattern summary file — a running overview of recent patterns visible in the vault. Use to refresh the summary after significant activity or when the user wants a current snapshot.",
      {},
      () => synthesis.sb_write_pattern_summary().then(ok));

    // ── Retrieval tools ───────────────────────────────────────────────────────
    server.tool("sb_search",
      "Semantic vector search across all vault content — use to find notes, documents, memories, or observations by meaning rather than exact words. Good for 'what do we know about X' or 'find anything related to Y'.",
      { query: z.string().max(10_000), limit: z.number().optional() },
      (args) => retrieval.sb_search(args).then(ok));

    server.tool("sb_recall",
      "Retrieve recent vault entries filtered by companion and/or content type — use to recall what was written about a specific companion (drevan, cypher, gaia) or to list recent notes, documents, or session summaries.",
      { companion: z.string().nullable(), content_type: z.string().max(64).optional(), limit: z.number().optional() },
      (args) => retrieval.sb_recall(args).then(ok));

    server.tool("sb_recent_patterns",
      "Read the current hearth pattern summary from the vault — use to get a quick overview of recent patterns without doing a full search. Returns the summary file content.",
      {},
      () => retrieval.sb_recent_patterns({ vaultAdapter: adapter, summaryPath: heartSummaryPath }).then(ok));

    // ── System tools ──────────────────────────────────────────────────────────
    server.tool("sb_status",
      "Return the health and status of the second brain system — use to check if the vector store, vault adapter, and embeddings are working. Shows document count and system configuration.",
      {},
      () => system.sb_status().then(ok));

    server.tool("sb_reindex_note",
      "Re-embed and re-index a single vault file by path — use when a note was edited outside of the MCP tools and needs its vector index updated so it shows up correctly in search.",
      { path: z.string() },
      (args) => system.sb_reindex_note(args).then(ok));

    server.tool("sb_index_rebuild",
      "Rebuild the vector index for a list of vault file paths — use to re-index multiple files at once after bulk edits, or to repair the search index if results seem stale or missing.",
      { paths: z.array(z.string()) },
      (args) => system.sb_index_rebuild(args).then(ok));

    server.tool("sb_read",
      "Read the raw content of a vault file by path — use to retrieve and display a specific note or document from the Obsidian vault. Returns the full markdown text.",
      { path: z.string() },
      (args) => system.sb_read(args).then(ok));

    server.tool("sb_list",
      "List all files in the vault or under a specific folder path — use to browse what exists in the second brain, see what's in a companion's folder, or audit vault contents.",
      { path: z.string().optional() },
      (args) => system.sb_list(args).then(ok));

    server.tool("sb_move",
      "Move or rename a vault file from one path to another — use to organize notes out of INBOX into permanent locations, rename files, or restructure the vault.",
      { from: z.string(), to: z.string() },
      (args) => system.sb_move(args).then(ok));

    return server;
  }

  return { makeMcpServer, synthesis, adapter, store };
}
