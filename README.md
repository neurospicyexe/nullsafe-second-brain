# nullsafe-second-brain

A memory server for the Nullsafe companion system. It reads session data from Halseth, synthesizes it into an [Obsidian](https://obsidian.md) vault, and maintains a searchable index so companions can retrieve memories semantically across sessions.

Can run locally (stdio transport for Claude Desktop) or on a VPS (HTTP/OAuth transport for Claude.ai). Connects to Claude via the MCP protocol.

---

> **⚠️ Disclaimer**
> This project was built with AI assistance ("vibe-coded"). Security hardening has been applied to the best of our ability, but this software comes with **no warranty and no liability**. It has not undergone a professional security audit. Secrets are stored in a local config file — keep that file private. If you use it, you use it at your own risk.

---

**Not sure where to start?** See [INSTALL.md](./INSTALL.md) for a beginner-friendly guide covering both local and VPS setup.

---

## What you need before starting

- [Node.js](https://nodejs.org) v20 or higher
- [Obsidian](https://obsidian.md) with a vault already created (free)
- An [OpenAI API key](https://platform.openai.com/api-keys) (for embeddings — the semantic search part)
- [Halseth](https://github.com/neurospicyexe/halseth) deployed and running

---

## Setup — step by step

### 1. Clone and install

```bash
git clone https://github.com/neurospicyexe/nullsafe-second-brain
cd nullsafe-second-brain
npm install
```

### 2. Create your config file

```bash
cp second-brain.config.example.json second-brain.config.json
```

Open `second-brain.config.json` in any text editor and fill in the blanks:

| Setting | What to put |
|---------|------------|
| `vault.path` | The full path to your Obsidian vault folder on your computer |
| `halseth.url` | Your Halseth URL, e.g. `https://halseth.your-account.workers.dev` |
| `halseth.secret` | Your Halseth `ADMIN_SECRET` passphrase |
| `embeddings.api_key` | Your OpenAI API key |
| `companions[].id` | The companion IDs from your Halseth setup (e.g. `drevan`, `cypher`, `gaia`) |

> `second-brain.config.json` is gitignored — it will never be pushed to GitHub.

**Example vault path:**
- Mac: `/Users/yourname/Documents/MyVault`
- Windows: `C:/Users/yourname/Documents/MyVault`

### 3. Build

```bash
npm run build
```

This compiles the TypeScript to `dist/`. Only needs to be done once (and again after any code changes).

### 4. Connect to Claude

Open your Claude Desktop config file:
- **Mac:** `~/.claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this (replace the path with the actual path to your cloned folder):

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "node",
      "args": ["C:/path/to/nullsafe-second-brain/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. You should see the `sb_` tools available.

### 5. Verify it's working

In a Claude session, ask:

> "What's the status of the second brain?"

Claude will call `sb_status` and tell you how many notes are indexed. If it's your first time, it'll say 0 — that's fine, it fills up as you use it.

---

## What Claude can do with this

**Saving things:**

| Tool | What it does |
|------|-------------|
| `sb_save_document` | Save a full document (stories, creative work, long-form artifacts) |
| `sb_save_note` | Save a synthesized note, routed to the right companion folder |
| `sb_save_study` | Save learning content to a subject folder |
| `sb_log_observation` | Log a pattern observation to your INBOX for review |

**Finding things:**

| Tool | What it does |
|------|-------------|
| `sb_search` | Search your vault by meaning (not just keywords) |
| `sb_recall` | Filter memories by companion, content type, or date |
| `sb_recent_patterns` | Return the latest pattern summary |

**Synthesis (pulls from Halseth):**

| Tool | What it does |
|------|-------------|
| `sb_synthesize_session` | Pull a Halseth session and write a summary note to the vault |
| `sb_run_patterns` | Analyze recent Halseth data and write observation notes |
| `sb_write_pattern_summary` | Generate a `_recent-patterns.md` for the Hearth dashboard |

**Vault browsing:**

| Tool | What it does |
|------|-------------|
| `sb_list` | List notes in a vault folder |
| `sb_read` | Read the content of a vault note |
| `sb_move` | Move a note to a different folder |

**Maintenance:**

| Tool | What it does |
|------|-------------|
| `sb_status` | Check how many notes are indexed and which companions have data |
| `sb_reindex_note` | Re-embed a note after you've manually edited it |
| `sb_index_rebuild` | Rebuild the index for a list of vault paths |

---

## Where files live

| File | Location | Notes |
|------|----------|-------|
| Config | `second-brain.config.json` | In the project folder. Gitignored. Keep it private. |
| Vector database | `~/.nullsafe-second-brain/vector-store.db` | Outside your vault so Obsidian Sync doesn't try to sync it. |
| Vault notes | Your Obsidian vault | Written by the server, readable in Obsidian normally. |

---

## Development

```bash
npm run dev    # run without building (uses tsx, slower start)
npm test       # run tests
npm run build  # compile to dist/
```

---

## Part of a suite

| Project | What it does |
|---------|-------------|
| [Halseth](https://github.com/neurospicyexe/halseth) | The data backend this reads from |
| [Hearth](https://github.com/neurospicyexe/hearth) | Visual dashboard (reads `_recent-patterns.md` this generates) |
| [nullsafe-plural-v2](https://github.com/neurospicyexe/nullsafe-plural-v2) | SimplyPlural fronting integration |
