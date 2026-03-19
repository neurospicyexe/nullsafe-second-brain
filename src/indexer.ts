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

export interface ChunkOutput {
  text: string;
  section: string;
  index: number;
}

export function paragraphChunk(text: string, maxChars = 1000, overlap = 200): ChunkOutput[] {
  if (text.trim().length === 0) return [];
  const results: ChunkOutput[] = [];
  const paragraphs = text.split(/\n\n+/);
  let window = "";
  let windowSection = "";
  let currentSection = "";
  let chunkIndex = 0;
  let overlapTail = "";

  const emit = () => {
    const trimmed = window.trim();
    if (!trimmed) return;
    results.push({ text: trimmed, section: windowSection, index: chunkIndex++ });
    overlapTail = overlap > 0 ? trimmed.slice(-overlap) : "";
    window = overlapTail;
    windowSection = currentSection;
  };

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Update section heading tracker
    const headingMatch = trimmed.match(/^#{1,2}\s+(.+)/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      // Headings are short -- include them in the window so section context appears in chunks
    }

    if (trimmed.length > maxChars) {
      // Paragraph too large -- must split on sentence boundaries
      // First emit current window if non-empty
      if (window.trim()) emit();

      const sentences = trimmed.split(/(?<=\. )/);
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;
        if (window && window.length + s.length + 1 > maxChars) emit();
        window = window ? window + " " + s : s;
        if (!windowSection) windowSection = currentSection;
      }
    } else {
      // Check if adding this paragraph would exceed maxChars
      const wouldBe = window ? window.length + 2 + trimmed.length : trimmed.length;
      if (window && wouldBe > maxChars) {
        emit();
      }
      // Accumulate into window
      window = window ? window + "\n\n" + trimmed : trimmed;
      if (!windowSection) windowSection = currentSection;
    }
  }

  // Emit any remaining window
  if (window.trim()) {
    results.push({ text: window.trim(), section: windowSection, index: chunkIndex++ });
  }

  return results;
}

export function contextPrefix(meta: { path: string; companion: string | null; contentType: string; section: string }): string {
  const parts = [meta.path];
  if (meta.companion) parts.push(`companion:${meta.companion}`);
  parts.push(meta.contentType);
  const sectionLine = meta.section ? `\n## ${meta.section}` : "";
  return `${parts.join(" | ")}:${sectionLine}\n`;
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
    const chunks = paragraphChunk(content);
    if (chunks.length === 0) return;
    const prefixedTexts = chunks.map(c =>
      contextPrefix({ path: vaultPath, companion, contentType: content_type, section: c.section }) + c.text
    );
    const embeddings = await this.embedder.embedBatch(prefixedTexts);
    this.store.deleteByPath(vaultPath);
    for (let i = 0; i < chunks.length; i++) {
      this.store.insert({
        vault_path: vaultPath,
        companion,
        content_type,
        chunk_text: chunks[i].text,
        prefixed_text: prefixedTexts[i],
        section: chunks[i].section,
        chunk_index: chunks[i].index,
        embedding: embeddings[i],
        tags,
      });
    }
  }
}
