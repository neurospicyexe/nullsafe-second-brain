import type { VaultAdapter } from "./adapters/vault-adapter.js";
import type { Embedder } from "./embeddings/embedder.js";
import type { VectorStore } from "./store/vector-store.js";
import type { ContentType } from "./types.js";

interface WriteOptions {
  path: string;
  content: string;
  companion: string | null;
  content_type: ContentType;
  tags: string[];
  overwrite?: boolean;
}

function chunkText(text: string, maxChars = 1000): string[] {
  if (text.trim().length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

export class Indexer {
  constructor(
    private adapter: VaultAdapter,
    private embedder: Embedder,
    private store: VectorStore,
  ) {}

  async write(options: WriteOptions): Promise<void> {
    await this.adapter.write({
      path: options.path,
      content: options.content,
      overwrite: options.overwrite ?? true,
    });
    await this.indexContent(
      options.path,
      options.content,
      options.companion,
      options.content_type,
      options.tags,
    );
  }

  async reindex(vaultPath: string): Promise<void> {
    // Look up existing metadata before deleting
    const existing = this.store.getAll().find(c => c.vault_path === vaultPath);
    const companion = existing?.companion ?? null;
    const content_type = (existing?.content_type ?? "note") as ContentType;
    const tags = existing?.tags ?? [];

    const content = await this.adapter.read(vaultPath);
    this.store.deleteByPath(vaultPath);
    await this.indexContent(vaultPath, content, companion, content_type, tags);
  }

  private async indexContent(
    vaultPath: string,
    content: string,
    companion: string | null,
    content_type: ContentType,
    tags: string[],
  ): Promise<void> {
    const chunks = chunkText(content);
    if (chunks.length === 0) return;  // nothing to index
    const embeddings = await this.embedder.embedBatch(chunks);
    this.store.deleteByPath(vaultPath);
    for (let i = 0; i < chunks.length; i++) {
      this.store.insert({
        vault_path: vaultPath,
        companion,
        content_type,
        chunk_text: chunks[i],
        embedding: embeddings[i],
        tags,
      });
    }
  }
}
