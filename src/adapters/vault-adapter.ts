export interface VaultWriteOptions {
  path: string;       // relative to vault root
  content: string;
  overwrite?: boolean;
}

/**
 * Outcome of a vault write. `delivered: false` means the adapter accepted the write but did NOT land it
 * (ObsidianRestAdapter queues for retry when Obsidian or its tunnel is down). Callers that count or
 * acknowledge writes must treat queued as its own bucket, never as written.
 */
export type VaultWriteResult = { delivered: true } | { delivered: false; queued: true };

export interface VaultAdapter {
  write(options: VaultWriteOptions): Promise<VaultWriteResult>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  list(dirPath?: string): Promise<string[]>;
  move(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Number of accepted-but-undelivered writes. Only adapters with a retry queue implement it. */
  pendingCount?(): number;
}
