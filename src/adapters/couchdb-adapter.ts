import { fallbackMixedHashEach } from "octagonal-wheels/hash/purejs";
import type { VaultAdapter, VaultWriteOptions, VaultWriteResult } from "./vault-adapter.js";
import { assertVaultRelativePath } from "./safe-vault-path.js";

export interface CouchDBConfig {
  url: string;
  db: string;
  username: string;
  password: string;
  device_id?: string;
}

const CHUNK_SIZE = 500_000; // 500KB

/**
 * LiveSync's document id for a vault path, in its case-insensitive mode (the default, and what this
 * vault uses): the path lowercased, with a leading "/" when the path starts with "_" (CouchDB reserves
 * ids that begin with an underscore). Verified 2026-11-02 against all 6,020 note docs in
 * obsidian-vault: zero mismatches. The doc's own `path` field keeps the original case.
 */
export function livesyncDocId(path: string): string {
  const lower = path.toLowerCase();
  return lower.startsWith("_") ? "/" + lower : lower;
}

interface NoteMeta {
  _id: string;
  path?: string;
  type?: string;
  children?: string[];
  eden?: Record<string, { data?: string }>;
  deleted?: boolean;
  _deleted?: boolean;
  ctime?: number;
  mtime?: number;
  _rev?: string;
}

const NOTE_TYPES = new Set(["plain", "newnote"]);
const isLive = (d: NoteMeta | null | undefined): d is NoteMeta =>
  !!d && !d.deleted && !d._deleted && (d.type === undefined || NOTE_TYPES.has(d.type));

export class CouchDBAdapter implements VaultAdapter {
  private baseUrl: string;
  private authHeader: string;

  constructor(private config: CouchDBConfig) {
    this.baseUrl = `${config.url}/${config.db}`;
    this.authHeader = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }

  private headers(): Record<string, string> {
    return { Authorization: this.authHeader, "Content-Type": "application/json" };
  }

  private chunkId(slice: Buffer): string {
    // LiveSync uses MurmurHash3 + FNV-1a base-36 (octagonal-wheels fallbackMixedHashEach).
    // Format: "h:" + ~13-char alphanumeric. Must match LiveSync's algorithm exactly,
    // otherwise LiveSync cannot resolve the chunk lookup and silently skips the file.
    return "h:" + fallbackMixedHashEach(slice.toString("utf-8"));
  }

  private async getDoc(id: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15_000),
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CouchDB GET ${id} failed: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async putDoc(id: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      method: "PUT",
      signal: AbortSignal.timeout(15_000),
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CouchDB PUT ${id} failed: ${res.status}`);
  }

  async write({ path, content, overwrite = true }: VaultWriteOptions): Promise<VaultWriteResult> {
    assertVaultRelativePath(path);
    if (!overwrite && await this.exists(path)) return { delivered: true };

    const now = Date.now();
    const buf = Buffer.from(content, "utf-8");

    // Split into chunks
    const chunkIds: string[] = [];
    for (let i = 0; i < buf.length || chunkIds.length === 0; i += CHUNK_SIZE) {
      const slice = buf.slice(i, i + CHUNK_SIZE);
      const id = this.chunkId(slice);
      if (!await this.getDoc(id)) {
        await this.putDoc(id, {
          _id: id,
          data: slice.toString("utf-8"),
          type: "leaf"
        });
      }
      chunkIds.push(id);
    }

    // Get existing rev for metadata doc (needed for updates).
    // Metadata shape must match what LiveSync produces: _id, _rev?, children,
    // path, ctime, mtime, size, type, eden. Extras like `device` or `modified`
    // are foreign and may cause LiveSync to flag the doc.
    const existing = await this.getDoc(path);
    const metaDoc: Record<string, unknown> = {
      _id: path,
      path,
      children: chunkIds,
      ctime: (existing?.ctime as number) ?? now,
      mtime: now,
      size: buf.length,
      type: "plain",
      eden: {},
    };
    if (existing?._rev) metaDoc._rev = existing._rev;

    await this.putDoc(path, metaDoc);
    return { delivered: true };
  }

  /**
   * Find a note's metadata doc. LiveSync's id first (every doc LiveSync wrote), then the raw path,
   * which is what this adapter's own legacy write() used as the id.
   */
  private async getMeta(path: string): Promise<NoteMeta | null> {
    const id = livesyncDocId(path);
    const doc = await this.getDoc(id) as NoteMeta | null;
    if (doc) return doc;
    return id === path ? null : await this.getDoc(path) as NoteMeta | null;
  }

  async read(path: string): Promise<string> {
    assertVaultRelativePath(path);
    const meta = await this.getMeta(path);
    if (!isLive(meta)) throw new Error(`File not found: ${path}`);

    const children = meta.children ?? [];
    // Fetch all chunks concurrently -- they're independent and order is preserved by index.
    // A chunk can live inline in `eden` (LiveSync's small-chunk cache) instead of as an h: doc.
    const chunkDocs = await Promise.all(
      children.map(async (chunkId) => {
        const inline = meta.eden?.[chunkId]?.data;
        if (typeof inline === "string") return inline;
        const chunk = await this.getDoc(chunkId);
        if (!chunk) throw new Error(`Missing chunk ${chunkId} for ${path}`);
        return chunk.data as string;
      })
    );
    const raw = chunkDocs.join("");
    // "newnote" is LiveSync's binary type: chunk data is base64.
    return meta.type === "newnote" ? Buffer.from(raw, "base64").toString("utf-8") : raw;
  }

  async exists(path: string): Promise<boolean> {
    assertVaultRelativePath(path);
    return isLive(await this.getMeta(path));
  }

  /** Every live note under dirPath (recursive), as vault paths in their original case. */
  async list(dirPath = ""): Promise<string[]> {
    assertVaultRelativePath(dirPath);
    const prefix = dirPath ? (dirPath.endsWith("/") ? dirPath : dirPath + "/") : "";
    const docs = prefix ? await this.metasUnder(prefix) : await this.allMetas();
    const wanted = prefix.toLowerCase();
    return docs
      .filter(isLive)
      .map(d => d.path ?? d._id)
      .filter(p => p.toLowerCase().startsWith(wanted));
  }

  /**
   * One directory level, shaped like Obsidian's REST listing: files as "<dir>/<name>", subfolders as
   * "<dir>/<name>/". Lets a read-through adapter answer sb_list identically with the PC off.
   */
  async listChildren(dirPath = ""): Promise<string[]> {
    const prefix = dirPath ? (dirPath.endsWith("/") ? dirPath : dirPath + "/") : "";
    const out = new Set<string>();
    for (const p of await this.list(dirPath)) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      out.add(slash === -1 ? p : p.slice(0, prefix.length + slash + 1));
    }
    return [...out].sort();
  }

  /** Metadata docs whose id sits under a prefix: a key-range read, so chunk docs are never fetched. */
  private async metasUnder(prefix: string): Promise<NoteMeta[]> {
    const start = livesyncDocId(prefix);
    const q = new URLSearchParams({
      include_docs: "true",
      startkey: JSON.stringify(start),
      endkey: JSON.stringify(start + "\ufff0"),
    });
    const res = await fetch(`${this.baseUrl}/_all_docs?${q}`, {
      signal: AbortSignal.timeout(30_000),
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`CouchDB _all_docs failed: ${res.status}`);
    const body = await res.json() as { rows: Array<{ id: string; doc?: NoteMeta }> };
    // Legacy docs written by this adapter keep their mixed-case path as the id and fall outside the
    // lowercase range; they are rare enough that the recursive root listing is where they surface.
    return body.rows.filter(r => !r.id.startsWith("h:") && r.doc).map(r => r.doc as NoteMeta);
  }

  /** Every note metadata doc. Mango _find returns only the small fields, never chunk bodies. */
  private async allMetas(): Promise<NoteMeta[]> {
    const res = await fetch(`${this.baseUrl}/_find`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: this.headers(),
      body: JSON.stringify({
        selector: { type: { $in: [...NOTE_TYPES] } },
        fields: ["_id", "path", "type", "deleted", "_deleted"],
        limit: 10_000_000,
      }),
    });
    if (!res.ok) throw new Error(`CouchDB _find failed: ${res.status}`);
    const body = await res.json() as { docs: NoteMeta[] };
    return body.docs;
  }

  async move(from: string, to: string): Promise<void> {
    assertVaultRelativePath(from);
    assertVaultRelativePath(to);
    const meta = await this.getDoc(from);
    if (!meta || meta.deleted) throw new Error(`File not found: ${from}`);

    const content = await this.read(from);
    await this.write({ path: to, content });

    // Soft-delete old path
    await this.putDoc(from, { ...meta, deleted: true, mtime: Date.now() });
  }

  async delete(path: string): Promise<void> {
    assertVaultRelativePath(path);
    const meta = await this.getDoc(path);
    if (!meta || meta.deleted) return;  // already gone / never existed
    await this.putDoc(path, { ...meta, deleted: true, mtime: Date.now() });
  }
}
