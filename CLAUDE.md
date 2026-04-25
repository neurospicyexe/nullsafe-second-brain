# nullsafe-second-brain

Node.js MCP server (TypeScript, stdio + HTTP transports). Layer 2 in the Nullsafe ecosystem: reads from Halseth and nullsafe-plural-v2 via HTTP, synthesizes content into an Obsidian vault, and maintains a SQLite vector store for companion RAG retrieval.

Part of the BBH suite — see root `CLAUDE.md` for cross-project context.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (vitest) |
| `npm run dev` | Start with tsx (requires `second-brain.config.json`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server (build first) |

## Architecture

```
src/
  adapters/         VaultAdapter interface + FilesystemAdapter + CouchDBAdapter
  index-http.ts     HTTP entry point — StreamableHTTP transport
  clients/          HalsethClient, PluralClient — HTTP wrappers for upstream MCPs
  embeddings/       Embedder interface + OpenAIEmbedder
  store/            VectorStore — SQLite via better-sqlite3
  tools/            capture.ts, retrieval.ts, synthesis.ts, system.ts — MCP tool builders
  config.ts         loadConfig() — zod-validated config loader
  indexer.ts        Indexer — dual-write pipeline: vault write + embed + vector store insert
  router.ts         RouteResolver — path → config rules → 00-INBOX/ default
  server.ts         createServer() — wires dependencies, registers MCP tools
  index.ts          stdio entry point
```

## Key Invariants

- Companion names are never hardcoded. Always `companion.id` from config.
- Companion IDs are always lowercase in config. Tool inputs normalize via `.toLowerCase()`.
- All vault paths must end in `.md`. `capture.ts` enforces this via `ensureMd()`.
- The CouchDB adapter is used automatically when `couchdb` is present in config.
- `second-brain.config.json` is gitignored. Only `second-brain.config.example.json` is committed.
- The SQLite vector store lives in `~/.nullsafe-second-brain/vector-store.db` — outside the vault folder.
- All vault writes go through `Indexer.write()` — direct adapter calls bypass the vector store.
- `sb_log_observation` always routes to INBOX. Never writes directly to permanent folders.
- `relational_deltas` in Halseth is read-only from this system — never write back to it.
- `reindex()` preserves companion/content_type/tags by reading existing metadata before deleting and re-inserting.

## Config Files

| File | Git | Purpose |
|------|-----|---------|
| `second-brain.config.example.json` | committed | Structure with placeholder values |
| `second-brain.config.json` | gitignored | Your actual config — vault path, companion IDs, API keys |

## Ingestion Pipeline (Spiral RAG)

Runs inside this process via `src/ingestion/`.

```
src/ingestion/
  types.ts              SourceType, IngestRecord, IngestionConfig
  config.ts             loadIngestionConfig() — env: DEEPSEEK_API_KEY, HALSETH_URL, etc.
  hwm.ts                High-water mark store (SQLite) — per-source dedup
  puller.ts             13-source Halseth puller (feelings, relational_delta, companion_journal,
                        synthesis_summary, inter_companion_note, handoff, wound, companion_dream,
                        open_loop, relational_state, tension, growth_journal, companion_conclusion)
  deepseek-client.ts    Shared DeepSeek HTTP client
  deepseek-wrapper.ts   Wraps each record with narrative framing via DeepSeek
  chunker.ts            semanticChunk() — splits large files at topic/emotional pivots via DeepSeek
  corpus.ts             processCorpus() — batch indexer for raw .md files
  gap-detector.ts       Finds relational sessions missing companion notes
  evaluator.ts          Drift evaluator — classifyDrift per companion, every 6h
  sit-prompts.ts        Flags stale sitting notes for next companion boot, every 12h
  persona-feeder.ts     Extracts organic voice blocks → persona_blocks, every 6h
  pattern-synthesizer.ts  Weekly synthesis of companion write corpus → [pattern_synthesis] entries
  cron-health.ts        Process-level cron health tracking
  pipeline.ts           Full pull → wrap → embed → insert with HWM + dedup
  scheduler.ts          5 cron jobs: ingestion (20min), drift eval (6h), persona feed (6h),
                        sit prompts (12h), pattern synth (weekly) + hourly stale check

scripts/
  run-corpus.ts         CLI for one-shot historical backfill
```

**Corpus backfill:** Run via `screen` or `nohup` — DeepSeek calls take 30–120s per file. Re-runs are safe; dedup is path-based and successful chunks are never re-indexed.

## Deployment

Runs on VPS behind a Cloudflare Tunnel. See `docs/deployment.md` for full setup, architecture, and debugging notes.

## Security

OWASP full audit + vibesec deep scan completed. Open findings: `docs/security-audit.md`
