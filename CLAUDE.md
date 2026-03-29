# CLAUDE.md

`nullsafe-second-brain` is a local MCP server (Node.js, TypeScript, stdio transport). Layer 2 in the Nullsafe ecosystem: reads from halseth and nullsafe-plural-v2 via HTTP, synthesizes content into an Obsidian vault, and maintains a SQLite vector store for companion RAG retrieval.

Part of the BBH suite -- see root `CLAUDE.md` for cross-project context.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (vitest) |
| `npm run dev` | Start the server with tsx (requires second-brain.config.json) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run compiled server (requires build first) |

## Architecture

```
src/
  adapters/       VaultAdapter interface + FilesystemAdapter + CouchDBAdapter
  index-http.ts   HTTP entry point -- StreamableHTTP transport for Claude.ai (2025-03-26 spec)
  clients/        HalsethClient, PluralClient -- HTTP wrappers for external MCPs
  embeddings/     Embedder interface + OpenAIEmbedder
  store/          VectorStore -- SQLite via better-sqlite3
  tools/          capture.ts, retrieval.ts, synthesis.ts, system.ts -- MCP tool builders
  config.ts       loadConfig() -- zod-validated config loader
  indexer.ts      Indexer -- dual-write pipeline: vault write + embed + vector store insert
  router.ts       RouteResolver -- explicit path → config rules → 00 - INBOX/ default
  server.ts       createServer() -- wires all dependencies, registers MCP tools
  index.ts        Entry point -- loads config, creates server, connects stdio transport
```

## Key Invariants

- Companion names are never hardcoded. Always `companion.id` from config.
- Companion IDs are always lowercase in config. Tool inputs normalize via `.toLowerCase()`.
- All paths written to the vault must end in `.md`. `capture.ts` enforces this automatically via `ensureMd()`.
- The CouchDB adapter is used automatically when `couchdb` is present in config.
- `second-brain.config.json` is gitignored. Only `second-brain.config.example.json` is committed.
- The SQLite vector store lives in `~/.nullsafe-second-brain/vector-store.db` -- outside the vault folder.
- All vault writes go through `Indexer.write()` -- direct adapter calls bypass the vector store.
- `sb_log_observation` always routes to INBOX. Never writes directly to permanent folders.
- `relational_deltas` in halseth is read-only from this system -- we never write back to it.
- `reindex()` preserves companion/content_type/tags by reading existing metadata before deleting and re-inserting.

## Config Files

| File | Git | Purpose |
|------|-----|---------|
| `second-brain.config.example.json` | committed | Structure with placeholder values |
| `second-brain.config.json` | gitignored | Your actual config -- vault path, companion ids, API keys |

## Ingestion Pipeline (Spiral Rag v2)

Live as of 2026-03-26. Runs inside this process via `src/ingestion/`.

```
src/ingestion/
  types.ts          SourceType, IngestRecord, IngestionConfig
  config.ts         loadIngestionConfig() -- env vars: DEEPSEEK_API_KEY, HALSETH_URL, etc.
  hwm.ts            High-water mark store (SQLite) -- per-source dedup
  puller.ts         6-source Halseth puller (feelings, deltas, journal, summaries, observations, notes)
  deepseek-wrapper.ts  Wraps each record with narrative framing via DeepSeek
  chunker.ts        semanticChunk() -- splits large files at topic/emotional pivots via DeepSeek
  corpus.ts         processCorpus() -- batch indexer for raw .md files
  pipeline.ts       Full pull → wrap → embed → insert pipeline with HWM + dedup
  scheduler.ts      Cron: runs pipeline every 20 minutes
scripts/
  run-corpus.ts     CLI for one-shot historical backfill
```

**Corpus backfill status (2026-03-27):** 43 raw conversation files indexed. 4 chunks failed
with OpenAI 400 (embed errors) -- re-runnable. Vector store has 548 total rows across all
content types. Re-run `scripts/run-corpus.ts` to retry failed chunks (dedup skips the rest).

**Operational notes:**
- Run corpus backfill via `screen` or `nohup` -- DeepSeek calls take 30-120s per file and SSH drops
- Re-runs are safe -- dedup is path-based, successful chunks are never re-indexed
- Check failed chunks: `grep "failed to index" /tmp/corpus-run.log`
- Inspect store (no sqlite3 CLI): `node -e "const D=require('better-sqlite3'); const db=new D(require('os').homedir()+'/.nullsafe-second-brain/vector-store.db'); console.log(db.prepare('SELECT content_type,COUNT(*) n FROM embeddings GROUP BY content_type').all())"`

## Deployment

Runs on VPS at `mcp.softcrashentity.com`. Fully operational as of 2026-03-13.
Setup checklist, architecture, and debugging history: `docs/deployment.md`

## Security

OWASP full audit + vibesec deep scan 2026-03-13.
**Immediate action still open: rotate `http.api_key` on VPS** (key exposed in chat 2026-03-11).
Open findings: `docs/security-audit.md`

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
