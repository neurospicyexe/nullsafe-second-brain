import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { VaultAdapter, VaultWriteOptions, VaultWriteResult } from "./vault-adapter.js";
import { assertVaultRelativePath } from "./safe-vault-path.js";

export interface ObsidianRestConfig {
  url: string;          // e.g. https://obsidian.your-domain.example.com (no trailing slash)
  apiKey: string;
  queuePath?: string;   // SQLite file for offline write queue (default: ~/.nullsafe-second-brain/vault-queue.db)
  retryIntervalMs?: number; // base retry interval (default 30s)
  maxAttempts?: number; // park in dead_writes after this many tries (default 50)
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
      -- 2026-10-08: a write that exhausts its retries is PARKED here, never deleted. The 10-07
      -- tunnel teardown (K16) left 66 writes counting down to a silent drop; vault content
      -- must not vanish because a route was down for two days. Re-queue with
      -- INSERT INTO pending_writes (path, content) SELECT path, content FROM dead_writes.
      CREATE TABLE IF NOT EXISTS dead_writes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        enqueued_at INTEGER NOT NULL,
        died_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    this.startRetryLoop();
  }

  /**
   * A failed PUT is queued for retry and reported as `{ delivered: false, queued: true }`, never thrown.
   * Returning normally used to make callers count an undelivered write as written (vault-materializer
   * then PATCHed vault_path on Halseth for a file that did not exist). The result makes the two cases
   * distinguishable; only the path-traversal guard still throws.
   */
  async write({ path, content, overwrite = true }: VaultWriteOptions): Promise<VaultWriteResult> {
    assertVaultRelativePath(path);
    if (!overwrite && (await this.exists(path))) return { delivered: true };
    try {
      await this.putFile(path, content);
      this.queue.prepare("DELETE FROM pending_writes WHERE path = ?").run(path);
      return { delivered: true };
    } catch (err) {
      const detail = describeError(err);
      this.enqueue(path, content, detail);
      console.error(`[obsidian-rest] write failed, queued: ${path} | ${detail}`);
      return { delivered: false, queued: true };
    }
  }

  async read(path: string): Promise<string> {
    assertVaultRelativePath(path);
    const res = await fetch(`${this.base}/vault/${encodeVaultPath(path)}`, {
      headers: { Authorization: this.headers.Authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw new Error(`File not found: ${path}`);
    if (!res.ok) throw new Error(`Obsidian REST GET ${path} failed: ${res.status}`);
    return res.text();
  }

  async exists(path: string): Promise<boolean> {
    assertVaultRelativePath(path);
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
    assertVaultRelativePath(dirPath);
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
    assertVaultRelativePath(from);
    assertVaultRelativePath(to);
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

  async delete(path: string): Promise<void> {
    assertVaultRelativePath(path);
    // Drop any queued write for this path first, so the retry loop can't
    // resurrect the file after we delete it.
    this.queue.prepare("DELETE FROM pending_writes WHERE path = ?").run(path);
    const res = await fetch(`${this.base}/vault/${encodeVaultPath(path)}`, {
      method: "DELETE",
      headers: { Authorization: this.headers.Authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Obsidian REST DELETE ${path} failed: ${res.status}`);
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
        const message = describeError(err);
        if (attempts >= this.maxAttempts) {
          console.error(`[obsidian-rest] parking ${row.path} in dead_writes after ${attempts} attempts: ${message}`);
          this.queue.transaction(() => {
            this.queue.prepare(
              "INSERT INTO dead_writes (path, content, attempts, last_error, enqueued_at) VALUES (?, ?, ?, ?, ?)",
            ).run(row.path, row.content, attempts, message, (row as QueueRow & { enqueued_at?: number }).enqueued_at ?? Math.floor(Date.now() / 1000));
            this.queue.prepare("DELETE FROM pending_writes WHERE id = ?").run(row.id);
          })();
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

/** Walk an error chain (Node fetch wraps the real cause). Returns "msg | cause: msg | code: X". */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cur: unknown = err.cause;
  while (cur instanceof Error) {
    parts.push(`cause: ${cur.message}`);
    if ((cur as NodeJS.ErrnoException).code) parts.push(`code: ${(cur as NodeJS.ErrnoException).code}`);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}
