interface PluralClientOptions {
  enabled: boolean;
  url?: string;
}

interface FrontState {
  front: string;
  co_con: string[];
}

export class PluralClient {
  constructor(private options: PluralClientOptions) {}

  async getCurrentFront(): Promise<FrontState | null> {
    if (!this.options.enabled || !this.options.url) return null;
    const response = await fetch(`${this.options.url}/front/current`);
    if (!response.ok) {
      throw new Error(`Plural request failed: ${response.statusText}`);
    }
    return response.json() as Promise<FrontState>;
  }
}
