interface HalsethClientOptions {
  url: string;
  secret: string;
}

export class HalsethClient {
  constructor(private options: HalsethClientOptions) {}

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.options.url}${path}`, {
      headers: { "Authorization": `Bearer ${this.options.secret}` },
    });
    if (!response.ok) {
      throw new Error(`Halseth request failed: ${response.statusText}`);
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
