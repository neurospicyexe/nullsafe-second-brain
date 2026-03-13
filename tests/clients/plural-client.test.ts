import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluralClient } from "../../src/clients/plural-client.js";

describe("PluralClient", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ front: "member-a", co_con: [] }),
    }) as unknown as typeof fetch;
  });

  it("returns null when plural is disabled", async () => {
    const client = new PluralClient({ enabled: false });
    expect(await client.getCurrentFront()).toBeNull();
  });

  it("returns null when enabled but no url", async () => {
    const client = new PluralClient({ enabled: true });
    expect(await client.getCurrentFront()).toBeNull();
  });

  it("fetches current front when enabled with url", async () => {
    const client = new PluralClient({ enabled: true, url: "https://plural.example.com" });
    const front = await client.getCurrentFront();
    expect(front?.front).toBe("member-a");
    expect(front?.co_con).toEqual([]);
  });

  it("throws on non-ok response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down",
    });
    const client = new PluralClient({ enabled: true, url: "https://plural.example.com" });
    await expect(client.getCurrentFront()).rejects.toThrow("Plural");
  });
});
