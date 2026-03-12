import type { Embedder } from "./embedder.js";

interface OpenAIEmbedderOptions {
  model: string;
  apiKey: string;
}

export class OpenAIEmbedder implements Embedder {
  constructor(private options: OpenAIEmbedderOptions) {}

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: texts, model: this.options.model }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`OpenAI embeddings fetch failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`OpenAI embeddings error: ${response.status} ${response.statusText} — ${body}`);
    }
    const json = await response.json() as { data: { embedding: number[] }[] };
    return json.data.map(d => d.embedding);
  }
}
