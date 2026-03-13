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
    const response = await fetch(`${this.options.url}/front/current`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`Plural /front/current → ${response.status} ${response.statusText}: ${body}`);
    }
    return response.json() as Promise<FrontState>;
  }
}
