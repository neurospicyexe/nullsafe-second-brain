interface HalsethClientOptions {
  url: string;
  secret: string;
}

export class HalsethClient {
  constructor(private options: HalsethClientOptions) {}

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.options.url}${path}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "Authorization": `Bearer ${this.options.secret}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`Halseth ${path} → ${response.status} ${response.statusText}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  async getSession(id: string): Promise<Record<string, unknown>> {
    return this.get(`/sessions/${id}`);
  }

  async getRecentSessions(days = 7): Promise<Record<string, unknown>[]> {
    return this.get(`/sessions?days=${days}`);
  }

  async getRecentDeltas(days = 7): Promise<Record<string, unknown>[]> {
    return this.get(`/deltas?days=${days}`);
  }

  async getHandover(id: string): Promise<Record<string, unknown>> {
    return this.get(`/handover/${id}`);
  }

  async getRoutines(date?: string): Promise<Record<string, unknown>[]> {
    return this.get(`/routines${date ? `?date=${date}` : ""}`);
  }
}
