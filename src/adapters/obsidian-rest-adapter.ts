import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { VaultAdapter, VaultWriteOptions } from "./vault-adapter.js";

export interface ObsidianRestConfig {
  url: string;          // e.g. https://obsidian.softcrashentity.com (no trailing slash)
  apiKey: string;
  queuePath?: string;   // SQLite file for offline write queue (default: ~/.nullsafe-second-brain/vault-queue.db)
  retryIntervalMs?: number; // base retry interval (default 30s)
  maxAttempts?: number; // give up after this many tries (default 50)
}

interface QueueRow {
  id: number;
  path: string;
  content: string;
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
}

export class ObsidianRestAdapter implements VaultAdapter {
  private base: string;
  private headers: Record<string, string>;
  private queue: Database.Database;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryIntervalMs: number;
  private maxAttempts: number;

  constructor(config: ObsidianRestConfig) {
    this.base = config.url.replace(/\/$/, "");
    this.headers = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "text/markdown",
    };
    this.retryIntervalMs = config.retryIntervalMs ?? 30_000;
    this.maxAttempts = config.maxAttempts ?? 50;

    const queuePath = config.queuePath
      ?? `${process.env.HOME ?? process.env.USERPROFILE}/.nullsafe-second-brain/vault-queue.db`;
    mkdirSync(dirname(queuePath), { recursive: true });
    this.queue = new Database(queuePath);
    this.queue.exec(`
      CREATE TABLE IF NOT EXISTS pending_writes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        enqueued_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    this.startRetryLoop();
  }

  async write({ path, content, overwrite = true }: VaultWriteOptions): Promise<void> {
    if (!overwrite && (await this.exists(path))) return;
    try {
      await this.putFile(path, content);
      // Success — clear any prior queue entry for this path
      this.queue.prepare("DELETE FROM pending_writes WHERE path = ?").run(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.enqueue(path, content, message);
      // Don't throw — caller should treat queued writes as accepted-with-deferral.
      // Loud log so this doesn't go silent.
      console.error(`[obsidian-rest] write failed, queued: ${path} (${message})`);
    }
  }

  async read(path: string): Promise<string> {
    const res = await fetch(`${this.base}/vault/${encodeVaultPath(path)}`, {
      headers: { Authorization: this.headers.Authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw new Error(`File not found: ${path}`);
    if (!res.ok) throw new Error(`Obsidian REST GET ${path} failed: ${res.status}`);
    return res.text();
  }

  async exists(path: string): Promise<boolean> {
    const res = await fetch(`${this.base}/vault/${encodeVaultPath(path)}`, {
      method: "HEAD",
      headers: { Authorization: this.headers.Authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Obsidian REST HEAD ${path} failed: ${res.status}`);
    return true;
  }

  async list(dirPath = ""): Promise<string[]> {
    const prefix = dirPath ? (dirPath.endsWith("/") ? dirPath : dirPath + "/") : "";
    const res = await fetch(`${this.base}/vault/${encodeVaultPath(prefix)}`, {
      headers: {
        Authorization: this.headers.Authorization,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Obsidian REST LIST ${prefix} failed: ${res.status}`);
    const body = await res.json() as { files?: string[] };
    return (body.files ?? []).map(name => prefix + name);
  }

  async move(from: string, to: string): Promise<void> {
    // No native move — read + write + delete.
    const content = await this.read(from);
    await this.write({ path: to, content, overwrite: true });
    const res = await fetch(`${this.base}/vault/${encodeVaultPath(from)}`, {
      method: "DELETE",
      headers: { Authorization: this.headers.Authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Obsidian REST DELETE ${from} failed: ${res.status}`);
    }
  }

  /** Stop the background retry loop and close the queue DB. */
  close(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.queue.close();
  }

  /** Returns count of pending queue entries — useful for health probes. */
  pendingCount(): number {
    const row = this.queue.prepare("SELECT COUNT(*) AS n FROM pending_writes").get() as { n: number };
    return row.n;
  }

  // --- internal ---

  private async putFile(path: string, content: string): Promise<void> {
    const res = await fetch(`${this.base}/vault/${encodeVaultPath(path)}`, {
      method: "PUT",
      headers: this.headers,
      body: content,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Obsidian REST PUT ${path} failed: ${res.status} ${res.statusText}`);
    }
  }

  private enqueue(path: string, content: string, error: string): void {
    const next = Date.now() + this.retryIntervalMs;
    this.queue.prepare(`
      INSERT INTO pending_writes (path, content, attempts, next_retry_at, last_error)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content = excluded.content,
        next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error
    `).run(path, content, next, error);
  }

  private startRetryLoop(): void {
    this.retryTimer = setInterval(() => {
      this.processQueue().catch(err => {
        console.error(`[obsidian-rest] queue processing error:`, err);
      });
    }, this.retryIntervalMs);
    // Don't keep the process alive just for this timer.
    this.retryTimer.unref?.();
  }

  private async processQueue(): Promise<void> {
    const now = Date.now();
    const due = this.queue
      .prepare("SELECT * FROM pending_writes WHERE next_retry_at <= ? ORDER BY enqueued_at LIMIT 25")
      .all(now) as QueueRow[];

    for (const row of due) {
      try {
        await this.putFile(row.path, row.content);
        this.queue.prepare("DELETE FROM pending_writes WHERE id = ?").run(row.id);
        console.log(`[obsidian-rest] queued write delivered: ${row.path}`);
      } catch (err) {
        const attempts = row.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        if (attempts >= this.maxAttempts) {
          console.error(`[obsidian-rest] giving up on ${row.path} after ${attempts} attempts: ${message}`);
          this.queue.prepare("DELETE FROM pending_writes WHERE id = ?").run(row.id);
          continue;
        }
        // Exponential backoff: base * 2^(attempts-1), capped at 1h
        const backoff = Math.min(this.retryIntervalMs * 2 ** (attempts - 1), 3_600_000);
        this.queue.prepare(`
          UPDATE pending_writes
          SET attempts = ?, next_retry_at = ?, last_error = ?
          WHERE id = ?
        `).run(attempts, Date.now() + backoff, message, row.id);
      }
    }
  }
}

/** Encode a vault-relative path for the URL. Preserves slashes; encodes spaces and special chars. */
function encodeVaultPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
