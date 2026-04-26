import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import type { SecondBrainConfig } from "./config.js";
import { FilesystemAdapter } from "./adapters/filesystem-adapter.js";
import { CouchDBAdapter } from "./adapters/couchdb-adapter.js";
import { ObsidianRestAdapter } from "./adapters/obsidian-rest-adapter.js";
import type { VaultAdapter } from "./adapters/vault-adapter.js";
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
  if (config.embeddings.provider === "ollama") {
    throw new Error('OllamaEmbedder is not yet implemented. Set embeddings.provider to "openai".');
  }

  // Adapter precedence: obsidian-rest (preferred) > couchdb > filesystem.
  // obsidian-rest is the supported path for VPS → Windows vault writes via
  // Obsidian's Local REST API plugin. CouchDBAdapter remains for legacy use
  // but its writes are not LiveSync-compatible (chunk hash mismatch).
  let adapter: VaultAdapter;
  if (config.vault.adapter === "obsidian-rest") {
    if (!config.obsidian_rest) {
      throw new Error('vault.adapter is "obsidian-rest" but obsidian_rest config is missing.');
    }
    adapter = new ObsidianRestAdapter({
      url: config.obsidian_rest.url,
      apiKey: config.obsidian_rest.api_key,
    });
  } else if (config.couchdb) {
    adapter = new CouchDBAdapter(config.couchdb);
  } else {
    adapter = new FilesystemAdapter(config.vault.path);
  }

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
  const system = buildSystemTools(store, indexer, adapter, embedder);

  function makeMcpServer() {
    const server = new McpServer({ name: "nullsafe-second-brain", version: "0.1.0" });
    const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
    const run = <T>(name: string, fn: () => Promise<T>) =>
      fn().then(ok).catch((err: unknown) => { console.error(`[tool:${name}]`, err); throw err; });

    // Capture tools
    // ── Capture tools ────────────────────────────────────────────────────────
    server.tool("sb_save_document",
      "Write content into the second brain vault. Use content_type='document' (default) for permanent records — companion memory, growth notes, relationship history, org knowledge. Use content_type='note' for lighter in-the-moment captures — session insights, quick reflections, brief thoughts. Optionally scoped to a companion (drevan, cypher, gaia).",
      { content: z.string().max(MAX_CONTENT_LENGTH), path: z.string().max(256).optional(), companion: z.string().max(64).optional(), tags: z.array(z.string()).max(50).optional(), content_type: z.enum(["document", "note"]).optional() },
      (args) => run("sb_save_document", () => capture.sb_save_document(args)));

    server.tool("sb_save_study",
      "Save learning material, research, or study notes into the vault — use when the user is learning something new, exploring a topic, or wants to retain educational content. Organized by subject.",
      { content: z.string().max(MAX_CONTENT_LENGTH), subject: z.string().max(256).optional(), tags: z.array(z.string()).max(50).optional() },
      (args) => run("sb_save_study", () => capture.sb_save_study(args)));

    server.tool("sb_log_observation",
      "Log a timestamped observation, pattern, or behavioral note into the INBOX — use to record what you notice about the user, a companion, or the system. Always goes to INBOX, never overwrites. Good for pattern tracking, emotional notes, or quick flags.",
      { content: z.string().max(MAX_CONTENT_LENGTH), tags: z.array(z.string()).max(50).optional() },
      (args) => run("sb_log_observation", () => capture.sb_log_observation(args)));

    server.tool("sb_ingest_raw",
      "Index raw text directly into the vault without synthesis — use for session transcripts, raw exchange pairs, or verbatim records that should be searchable but not summarized. Always overwrites. Stored in raziel/sessions/transcripts/.",
      { title: z.string().max(256), content: z.string().max(MAX_CONTENT_LENGTH), companion: z.string().max(64).optional(), tags: z.array(z.string()).max(20).optional() },
      (args) => run("sb_ingest_raw", () => capture.sb_ingest_raw(args)));

    // ── Synthesis tools ───────────────────────────────────────────────────────
    server.tool("sb_synthesize_session",
      "Pull a Halseth session by ID and write a structured session summary note into the vault — use after a significant session closes to preserve what happened, who was front, emotional state, and anchors.",
      { session_id: z.string() },
      (args) => synthesis.sb_synthesize_session(args).then(ok));

    server.tool("sb_run_patterns",
      "Analyze recent sessions and relational deltas from Halseth (last 7 days) and write a pattern observation to the vault. Default (summary=false): appends a new timestamped log entry. Pass summary=true to overwrite the hearth summary file with a current snapshot — use this to refresh the overview visible in sb_recent_patterns.",
      { summary: z.boolean().optional() },
      (args) => synthesis.sb_run_patterns(args).then(ok));

    // ── Retrieval tools ───────────────────────────────────────────────────────
    server.tool("sb_search",
      "Semantic vector search across all vault content — use to find notes, documents, memories, or observations by meaning rather than exact words. Good for 'what do we know about X' or 'find anything related to Y'.",
      { query: z.string().max(10_000), limit: z.number().optional() },
      (args) => retrieval.sb_search(args).then(ok));

    server.tool("sb_file_chunks",
      "Retrieve all chunks from a specific indexed file by filename — use to read a complete historical conversation, corpus file, or document that was chunked during ingestion. Returns chunks in order. Example filenames: 'Calethian2.md', 'spiralchoice.md'.",
      { filename: z.string().max(256), limit: z.number().optional() },
      (args) => retrieval.sb_file_chunks(args).then(ok));

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

    server.tool("sb_index_rebuild",
      "Rebuild the vector index for a list of vault file paths — use to re-index multiple files at once after bulk edits, or to repair the search index if results seem stale or missing.",
      { paths: z.array(z.string()) },
      (args) => system.sb_index_rebuild(args).then(ok));

    server.tool("sb_read",
      "Read a vault file by path. Without query: returns full markdown text. With query: returns top 3 most relevant excerpts ranked by semantic similarity — use when a file is long and you only need the parts most relevant to a specific question.",
      { path: z.string(), query: z.string().max(10_000).optional() },
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

  return { makeMcpServer, synthesis, adapter, store, embedder, indexer };
}
