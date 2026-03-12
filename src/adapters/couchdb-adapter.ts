import { createHash } from "crypto";
import type { VaultAdapter, VaultWriteOptions } from "./vault-adapter.js";

export interface CouchDBConfig {
  url: string;
  db: string;
  username: string;
  password: string;
  device_id?: string;
}

const CHUNK_SIZE = 500_000; // 500KB

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
    return "h:" + createHash("sha256").update(slice).digest("hex");
  }

  private async getDoc(id: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CouchDB GET ${id} failed: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async putDoc(id: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CouchDB PUT ${id} failed: ${res.status}`);
  }

  async write({ path, content, overwrite = true }: VaultWriteOptions): Promise<void> {
    if (!overwrite && await this.exists(path)) return;

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
          data: slice.toString("base64"),
          type: "leaf"
        });
      }
      chunkIds.push(id);
    }

    // Get existing rev for metadata doc (needed for updates)
    const existing = await this.getDoc(path);
    const metaDoc: Record<string, unknown> = {
      _id: path,
      path,
      children: chunkIds,
      ctime: (existing?.ctime as number) ?? now,
      mtime: now,
      modified: now, // LiveSync looks for modified in ms
      size: buf.length,
      type: existing ? "plain" : "newnote",
      device: this.config.device_id ?? "nullsafe-mcp-server",
      eden: {},
      ...(existing ? { deleted: false } : {}),
    };
    if (existing?._rev) metaDoc._rev = existing._rev;

    await this.putDoc(path, metaDoc);
  }

  async read(path: string): Promise<string> {
    const meta = await this.getDoc(path);
    if (!meta || meta.deleted) throw new Error(`File not found: ${path}`);

    const children = (meta.children as string[]) ?? [];
    const parts: string[] = [];
    for (const chunkId of children) {
      const chunk = await this.getDoc(chunkId);
      if (!chunk) throw new Error(`Missing chunk ${chunkId} for ${path}`);
      const data = chunk.data as string;
      try {
        parts.push(Buffer.from(data, "base64").toString("utf-8"));
      } catch {
        parts.push(data);
      }
    }
    return parts.join("");
  }

  async exists(path: string): Promise<boolean> {
    const doc = await this.getDoc(path);
    return doc !== null && !doc.deleted;
  }

  async list(dirPath = ""): Promise<string[]> {
    const prefix = dirPath ? (dirPath.endsWith("/") ? dirPath : dirPath + "/") : "";
    const res = await fetch(`${this.baseUrl}/_all_docs?include_docs=true`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`CouchDB _all_docs failed: ${res.status}`);
    const result = await res.json() as { rows: Array<{ id: string; doc: Record<string, unknown> }> };
    return result.rows
      .filter(r =>
        !r.id.startsWith("h:") &&
        !r.id.startsWith("_") &&
        r.id !== "obsydian_livesync_version" &&
        !r.doc.deleted &&
        r.doc.type !== "versioninfo" &&
        (prefix === "" || r.id.startsWith(prefix))
      )
      .map(r => r.id);
  }

  async move(from: string, to: string): Promise<void> {
    const meta = await this.getDoc(from);
    if (!meta || meta.deleted) throw new Error(`File not found: ${from}`);

    const content = await this.read(from);
    await this.write({ path: to, content });

    // Soft-delete old path
    await this.putDoc(from, { ...meta, deleted: true, mtime: Date.now() });
  }
}
