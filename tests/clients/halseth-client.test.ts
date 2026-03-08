import { describe, it, expect, vi, beforeEach } from "vitest";
import { HalsethClient } from "../../src/clients/halseth-client.js";

const makeClient = () => new HalsethClient({ url: "https://halseth.example.com", secret: "test-secret" });

describe("HalsethClient", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  function mockOk(data: unknown) {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => data,
    });
  }

  it("getSession fetches by id with auth header", async () => {
    mockOk({ id: "session-1", notes: "test" });
    const session = await makeClient().getSession("session-1");
    expect(session.id).toBe("session-1");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://halseth.example.com/sessions/session-1",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-halseth-secret": "test-secret" }),
      })
    );
  });

  it("getRecentSessions returns array", async () => {
    mockOk([{ id: "s1" }, { id: "s2" }]);
    const sessions = await makeClient().getRecentSessions(7);
    expect(sessions).toHaveLength(2);
  });

  it("getRecentDeltas returns array", async () => {
    mockOk([{ id: "d1", delta_text: "a moment" }]);
    const deltas = await makeClient().getRecentDeltas(7);
    expect(deltas[0].delta_text).toBe("a moment");
  });

  it("getHandover fetches by id", async () => {
    mockOk({ id: "h1", spine: "what happened" });
    const handover = await makeClient().getHandover("h1");
    expect(handover.spine).toBe("what happened");
  });

  it("getRoutines fetches with date param when provided", async () => {
    mockOk([]);
    await makeClient().getRoutines("2026-03-07");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://halseth.example.com/routines?date=2026-03-07",
      expect.any(Object)
    );
  });

  it("throws on non-ok response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, statusText: "Not Found" });
    await expect(makeClient().getSession("bad")).rejects.toThrow("Halseth request failed");
  });
});
