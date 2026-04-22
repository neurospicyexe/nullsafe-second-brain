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
    return this.get(`/sessions/${encodeURIComponent(id)}`);
  }

  async getRecentSessions(days = 7): Promise<Record<string, unknown>[]> {
    return this.get(`/sessions?days=${days}`);
  }

  // GET /deltas has no server-side date filter -- fetches a fixed batch and filters client-side.
  // If result hits 200 rows, older deltas in the window are silently excluded.
  // To fix properly: add ?since= param to the Halseth /deltas endpoint.
  async getRecentDeltas(days = 7): Promise<Record<string, unknown>[]> {
    const all = await this.get<Record<string, unknown>[]>(`/deltas?limit=200`);
    if (all.length >= 200) {
      console.warn(`[HalsethClient] getRecentDeltas: hit 200-row cap — deltas past row 200 silently excluded. Increase limit or add server-side date filter to /deltas.`);
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return all.filter(d => {
      const ts = d.created_at as string | undefined;
      return ts ? new Date(ts) >= cutoff : false;
    });
  }

  // GET /handovers returns a fixed batch; match by session_id client-side.
  // If result hits 100 rows, the target handover may be past the cap and return null.
  async getHandover(sessionId: string): Promise<Record<string, unknown> | null> {
    const all = await this.get<Record<string, unknown>[]>(`/handovers?limit=100`);
    if (all.length >= 100) {
      console.warn(`[HalsethClient] getHandover: hit 100-row cap — handover for ${sessionId} may be past the limit.`);
    }
    return all.find(h => h.session_id === sessionId) ?? null;
  }

  async getRoutines(date?: string): Promise<Record<string, unknown>[]> {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format: "${date}" — expected YYYY-MM-DD`);
    }
    return this.get(`/routines${date ? `?date=${date}` : ""}`);
  }
}
