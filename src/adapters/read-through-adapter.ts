import type { VaultAdapter, VaultWriteOptions, VaultWriteResult } from "./vault-adapter.js";

/**
 * Reads from a replica, writes through the primary. Built 2026-11-02 so Second Brain can read full
 * notes with the PC off: the primary is ObsidianRestAdapter (the PC's Obsidian, via the reverse
 * tunnel), the replica is CouchDBAdapter over LiveSync's obsidian-vault database on the VPS, which
 * LiveSync keeps in step with the PC whenever Obsidian is open.
 *
 * Writes, moves and deletes ALWAYS go to the primary. CouchDBAdapter's writes are not LiveSync-safe,
 * and Obsidian stays the one author of the vault.
 *
 * Reads go to the replica first, except where the replica is known to lag:
 *  - a path with a queued (undelivered) primary write: the newest content is in that queue;
 *  - a path this process wrote, moved or deleted in the last `freshMs`: LiveSync has not
 *    necessarily pushed the change to CouchDB yet.
 * For those, the primary answers first and the replica is the fallback when the primary is down.
 * A replica miss or error falls back to the primary, so a note LiveSync has not uploaded yet
 * still reads while the PC is on.
 */
export interface ReplicaAdapter extends VaultAdapter {
  /** One directory level in Obsidian REST's listing shape (subfolders end in "/"). */
  listChildren?(dirPath?: string): Promise<string[]>;
}

export interface ReadThroughOptions {
  /** How long after a local write/move/delete a path reads from the primary first. Default 5 min. */
  freshMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class ReadThroughAdapter implements VaultAdapter {
  private touched = new Map<string, number>();
  private freshMs: number;
  private now: () => number;
  private log: (msg: string) => void;

  constructor(
    private primary: VaultAdapter,
    private replica: ReplicaAdapter,
    opts: ReadThroughOptions = {},
  ) {
    this.freshMs = opts.freshMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  private key(path: string): string {
    return path.toLowerCase(); // the vault is case-insensitive on both sides
  }

  private touch(path: string): void {
    this.touched.set(this.key(path), this.now());
    if (this.touched.size > 5_000) this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.freshMs;
    for (const [k, t] of this.touched) if (t < cutoff) this.touched.delete(k);
  }

  /** True when the replica may not have this path's latest state yet. */
  private primaryFirst(path: string): boolean {
    if (this.primary.hasPending?.(path)) return true;
    const t = this.touched.get(this.key(path));
    return t !== undefined && this.now() - t < this.freshMs;
  }

  // ---- writes: primary only ----

  async write(options: VaultWriteOptions): Promise<VaultWriteResult> {
    try {
      return await this.primary.write(options);
    } finally {
      this.touch(options.path);
    }
  }

  async move(from: string, to: string): Promise<void> {
    try {
      await this.primary.move(from, to);
    } finally {
      this.touch(from);
      this.touch(to);
    }
  }

  async delete(path: string): Promise<void> {
    try {
      await this.primary.delete(path);
    } finally {
      this.touch(path);
    }
  }

  pendingCount(): number {
    return this.primary.pendingCount?.() ?? 0;
  }

  hasPending(path: string): boolean {
    return this.primary.hasPending?.(path) ?? false;
  }

  // ---- reads: replica first, primary as fallback ----

  async read(path: string): Promise<string> {
    if (this.primaryFirst(path)) {
      try {
        return await this.primary.read(path);
      } catch (err) {
        this.log(`[read-through] primary read failed for a fresh path, using replica: ${(err as Error).message}`);
        return this.replica.read(path);
      }
    }
    try {
      return await this.replica.read(path);
    } catch (replicaErr) {
      try {
        return await this.primary.read(path);
      } catch (primaryErr) {
        // Both failed. A replica "not found" is the truthful answer when the primary is merely
        // unreachable; otherwise surface the primary's error, it is the authority.
        const r = (replicaErr as Error).message;
        if (/^File not found/.test(r) && !/^File not found/.test((primaryErr as Error).message)) {
          throw replicaErr;
        }
        throw primaryErr;
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    if (this.primaryFirst(path)) {
      try {
        return await this.primary.exists(path);
      } catch {
        return this.replica.exists(path);
      }
    }
    try {
      if (await this.replica.exists(path)) return true;
    } catch (err) {
      this.log(`[read-through] replica exists failed, using primary: ${(err as Error).message}`);
    }
    // Not in the replica (or the replica errored): the primary may hold a note LiveSync has not
    // uploaded. If the primary is down too, the replica's "no" stands.
    try {
      return await this.primary.exists(path);
    } catch {
      return false;
    }
  }

  async list(dirPath = ""): Promise<string[]> {
    try {
      const fromReplica = this.replica.listChildren
        ? await this.replica.listChildren(dirPath)
        : await this.replica.list(dirPath);
      return this.mergeFresh(dirPath, fromReplica);
    } catch (err) {
      this.log(`[read-through] replica list failed, using primary: ${(err as Error).message}`);
      return this.primary.list(dirPath);
    }
  }

  /**
   * Add files this process wrote moments ago that the replica has not caught up on, so a write
   * followed by a listing does not look like a lost write. Only direct children are added;
   * deletes are not subtracted (a stale entry then reads through to the primary's 404).
   */
  private mergeFresh(dirPath: string, entries: string[]): string[] {
    const prefix = dirPath ? (dirPath.endsWith("/") ? dirPath : dirPath + "/") : "";
    const seen = new Set(entries.map(e => e.toLowerCase()));
    const out = [...entries];
    const cutoff = this.now() - this.freshMs;
    for (const [k, t] of this.touched) {
      if (t < cutoff || !k.startsWith(prefix.toLowerCase())) continue;
      const rest = k.slice(prefix.length);
      if (rest.includes("/") || seen.has(k)) continue;
      // touched keys are lowercased; this listing entry takes that case, which the
      // case-insensitive vault resolves.
      out.push(k);
      seen.add(k);
    }
    return out;
  }
}
