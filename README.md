# nullsafe-second-brain

A local MCP server that acts as the Layer 2 memory system for the Nullsafe ecosystem. It reads from halseth and nullsafe-plural-v2, synthesizes content into an Obsidian vault, and maintains a SQLite vector store for semantic retrieval by companions and future local LLMs.

## Prerequisites

- Node.js 20+
- An Obsidian vault (with Obsidian Sync if cross-device use is wanted)
- OpenAI API key (or configure `provider: "ollama"` for local embeddings)
- Halseth instance running (see github.com/nanayax3/halseth)

## Setup

```bash
git clone <this-repo>
cd nullsafe-second-brain
npm install
cp second-brain.config.example.json second-brain.config.json
# Edit second-brain.config.json — see Config Reference below
```

## Connect to Claude Code

Add to your Claude Code MCP config (`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "node",
      "args": ["/path/to/nullsafe-second-brain/dist/index.js"],
      "env": {}
    }
  }
}
```

Build first: `npm run build`

Or use `tsx` for development: replace `"node"` with `"npx"` and `args` with `["tsx", "/path/to/nullsafe-second-brain/src/index.ts"]`.

## Config Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `vault.adapter` | `"filesystem"` \| `"obsidian-rest"` | — | How to write to the vault |
| `vault.path` | string | — | Absolute path to your Obsidian vault |
| `halseth.url` | string | — | Your halseth worker URL |
| `halseth.secret` | string | — | HALSETH_SECRET value |
| `plural.enabled` | boolean | `false` | Enable SimplyPlural front state queries |
| `companions` | array | `[]` | See Companion Setup below |
| `triggers.on_demand` | boolean | `true` | Allow manual tool calls |
| `triggers.scheduled.enabled` | boolean | `false` | Run synthesis on a cron schedule |
| `triggers.scheduled.cron` | string | `"0 22 * * *"` | Cron expression for scheduled runs |
| `embeddings.provider` | `"openai"` \| `"ollama"` | — | Embedding backend |
| `embeddings.model` | string | — | Model name (e.g. `text-embedding-3-small`) |
| `embeddings.api_key` | string | — | OpenAI API key (if provider is openai) |

## Companion Setup

Each companion gets its own vault folder and vector store namespace. No companion names are hardcoded — everything is driven by config.

```json
{
  "companions": [
    {
      "id": "your-companion-id",
      "role": "companion",
      "vault_folder": "Companions/your-companion-id/"
    }
  ],
  "routing": [
    { "companion": "your-companion-id", "type": "document", "destination": "Companions/your-companion-id/Creative/" }
  ]
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `sb_save_document` | Full verbatim copy — no summarization. For stories, creative work, long-form artifacts. |
| `sb_save_note` | Synthesized note routed to a configured folder. |
| `sb_save_study` | Learning content filed under a subject folder. |
| `sb_log_observation` | Pattern observation — always lands in INBOX for review. |
| `sb_synthesize_session` | Pull a halseth session and write a summary note. |
| `sb_run_patterns` | Analyze recent halseth data and write observation notes. |
| `sb_write_pattern_summary` | Generate `_recent-patterns.md` for the Hearth dashboard widget. |
| `sb_search` | Semantic search across the full vault index. |
| `sb_recall` | Filtered retrieval by companion lane, content type, or date. |
| `sb_recent_patterns` | Return the pre-computed pattern summary. |
| `sb_status` | Index health, chunk count, companions indexed. |
| `sb_reindex_note` | Re-embed a single note after manual edits. |
| `sb_index_rebuild` | Rebuild index for a list of paths. |

## Development

```bash
npm test          # run all tests
npm run dev       # start server (requires second-brain.config.json)
npm run build     # compile to dist/
```
