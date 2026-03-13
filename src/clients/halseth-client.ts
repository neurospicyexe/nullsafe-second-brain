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

  // Fetch a single session by id.
  // Requires GET /sessions/:id endpoint (added to halseth 2026-03-13).
  async getSession(id: string): Promise<Record<string, unknown>> {
    return this.get(`/sessions/${encodeURIComponent(id)}`);
  }

  // Fetch sessions from the last N days.
  // Requires GET /sessions?days=N endpoint (added to halseth 2026-03-13).
  async getRecentSessions(days = 7): Promise<Record<string, unknown>[]> {
    return this.get(`/sessions?days=${days}`);
  }

  // Fetch relational deltas from the last N days.
  // GET /deltas does not accept a ?days= param — fetches a large batch
  // and filters client-side by created_at.
  async getRecentDeltas(days = 7): Promise<Record<string, unknown>[]> {
    const all = await this.get<Record<string, unknown>[]>(`/deltas?limit=200`);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return all.filter(d => {
      const ts = d.created_at as string | undefined;
      return ts ? new Date(ts) >= cutoff : false;
    });
  }

  // Fetch a handover by session_id.
  // GET /handovers returns a list; we find the matching one client-side.
  async getHandover(sessionId: string): Promise<Record<string, unknown> | null> {
    const all = await this.get<Record<string, unknown>[]>(`/handovers?limit=100`);
    return all.find(h => h.session_id === sessionId) ?? null;
  }

  async getRoutines(date?: string): Promise<Record<string, unknown>[]> {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format: "${date}" — expected YYYY-MM-DD`);
    }
    return this.get(`/routines${date ? `?date=${date}` : ""}`);
  }
}
