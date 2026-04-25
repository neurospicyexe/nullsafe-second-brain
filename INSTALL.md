# Installing nullsafe-second-brain

> **Tech-savvy?** The quick version is in [README.md](./README.md). This guide is for everyone else.

## What is this, in plain English?

The Second Brain is a memory server. It stores notes, session summaries, and semantic memories in an Obsidian vault, and lets Claude search through them by meaning (not just keywords). It reads data from Halseth and writes organized notes to your vault.

**You need Halseth running before this will work.**

---

## Local computer vs. VPS — which should I use?

**Local computer (simpler to start):**
Your second brain runs on your own machine. It works great, but it goes offline whenever your computer is off or asleep. Good for getting started and testing.

**VPS — a virtual private server (always-on):**
A VPS is a computer in a data center that runs 24/7. You rent one for ~$5-10/month (DigitalOcean, Hetzner, etc.). This is the recommended setup for long-term use so companions can always reach memory.

---

## What you need

- **Halseth** deployed and running
- **Node.js 20+** — [nodejs.org](https://nodejs.org) (LTS version)
- **Git** — [git-scm.com](https://git-scm.com)
- **An OpenAI API key** — for generating semantic embeddings. [platform.openai.com](https://platform.openai.com) → API keys. Text-embedding-ada-002 is very cheap (~$0.10 per million tokens).
- **An Obsidian vault folder** — a folder on your computer (or VPS) where notes will be saved. Obsidian itself is optional — the folder is what matters.

---

## Option A: Local computer

### 1. Get the code

```bash
git clone https://github.com/neurospicyexe/nullsafe-second-brain.git
cd nullsafe-second-brain
npm install
```

### 2. Create the config file

```bash
cp second-brain.config.example.json second-brain.config.json
```

Open `second-brain.config.json` in a text editor. Fill in:

- `vaultPath` — the full path to your Obsidian vault folder (e.g. `C:/Users/you/Documents/MyVault` on Windows, or `/Users/you/Documents/MyVault` on Mac)
- `halsethUrl` — your Halseth URL (e.g. `https://halseth.neurospicyexe.workers.dev`)
- `halsethSecret` — your Halseth `ADMIN_SECRET`
- `openaiApiKey` — your OpenAI API key
- `companions` — list of companion IDs (e.g. `["cypher", "drevan", "gaia"]`)

### 3. Start the server

```bash
npm run dev
```

You'll see `Server running` in the terminal. Leave this window open — closing it stops the server.

### 4. Connect Claude

In Claude Desktop's MCP config, add:

```json
{
  "second-brain": {
    "command": "node",
    "args": ["/full/path/to/nullsafe-second-brain/dist/index.js"]
  }
}
```

Build first if you haven't: `npm run build`

---

## Option B: VPS (always-on)

### Prerequisites on your VPS

SSH into your VPS and run:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
npm install -g pm2
```

### 1. Get the code on your VPS

```bash
git clone https://github.com/neurospicyexe/nullsafe-second-brain.git
cd nullsafe-second-brain
npm install
```

### 2. Create and configure `second-brain.config.json`

Same as the local setup above — vault path will be a folder on the VPS (e.g. `/home/you/vault`).

### 3. Build and start

```bash
npm run build
pm2 start dist/index-http.js --name second-brain
pm2 save
pm2 startup   # follow the printed instruction to make it survive reboots
```

### 4. Make it accessible to Claude

The server runs on port 3456 by default. To connect Claude to it, you'll need either:

- **Cloudflare Tunnel** (recommended, free) — creates a secure URL like `https://second-brain.yourdomain.com` without opening firewall ports. See [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
- **Direct port** — open port 3456 on your VPS firewall and use your VPS IP address directly (less secure).

### 5. Connect Claude

```json
{
  "second-brain": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://second-brain.yourdomain.com/mcp"],
    "env": { "MCP_AUTH_TOKEN": "your-auth-secret" }
  }
}
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Cannot find second-brain.config.json` | Make sure you copied and filled in the config file |
| Vault path not found | Check the path — use forward slashes even on Windows, and make sure the folder exists |
| OpenAI error on first run | Check your API key and make sure your OpenAI account has credits |
| Empty search results | The vector store takes a moment to build. Run `npm run dev`, let it index, then try again |
