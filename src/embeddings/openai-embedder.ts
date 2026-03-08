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
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: texts, model: this.options.model }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${response.statusText}`);
    }
    const json = await response.json() as { data: { embedding: number[] }[] };
    return json.data.map(d => d.embedding);
  }
}
