// The discord-live path is written in one place (POST /ingest/discord) and now read back in one
// place (POST /retract); both go through this helper so they can never disagree on the shape.
import { describe, it, expect } from "vitest";
import { discordLivePath, parseRetractBody } from "../retract.js";

describe("discordLivePath", () => {
  it("matches the ingest path shape exactly", () => {
    expect(discordLivePath("1497734427298762828", "1553229613210009773")).toBe("discord-live/1497734427298762828/1553229613210009773.md");
  });
  it("falls back to 'unknown' for a missing channel, like ingest does", () => {
    expect(discordLivePath("", "42")).toBe("discord-live/unknown/42.md");
    expect(discordLivePath(undefined, "42")).toBe("discord-live/unknown/42.md");
  });
});

describe("parseRetractBody", () => {
  it("accepts message_id (+channel_id) or an explicit discord-live vault_path", () => {
    expect(parseRetractBody({ channel_id: "1", message_id: "2" })).toEqual({ path: "discord-live/1/2.md" });
    expect(parseRetractBody({ vault_path: "discord-live/1/2.md" })).toEqual({ path: "discord-live/1/2.md" });
  });
  it("refuses anything outside discord-live: retract is for the live layer, never the vault proper", () => {
    expect(parseRetractBody({ vault_path: "raziel/sessions/2026-09-25-summary.md" })).toEqual({ error: expect.stringContaining("discord-live") });
    expect(parseRetractBody({ vault_path: "../discord-live/x.md" })).toEqual({ error: expect.any(String) });
    expect(parseRetractBody({})).toEqual({ error: expect.any(String) });
    expect(parseRetractBody({ message_id: "" })).toEqual({ error: expect.any(String) });
  });
});
