import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const validConfig = {
  vault: { adapter: "filesystem", path: "/tmp/vault" },
  halseth: { url: "https://example.com", secret: "abc" },
  plural: { enabled: false },
  companions: [],
  triggers: {
    scheduled: { enabled: false, cron: "0 22 * * *" },
    on_demand: true,
    event_driven: { enabled: false, on_session_close: false, on_handover: false },
  },
  routing: [],
  patterns: { enabled: true, hearth_summary: false, hearth_summary_path: "_recent-patterns.md" },
  embeddings: { provider: "openai", model: "text-embedding-3-small", api_key: "sk-test" },
};

describe("loadConfig", () => {
  it("loads and validates a valid config", () => {
    const tmpFile = join(tmpdir(), "test-config.json");
    writeFileSync(tmpFile, JSON.stringify(validConfig));
    const loaded = loadConfig(tmpFile);
    expect(loaded.vault.adapter).toBe("filesystem");
    expect(loaded.companions).toHaveLength(0);
    expect(loaded.triggers.on_demand).toBe(true);
    unlinkSync(tmpFile);
  });

  it("loads config with companions", () => {
    const cfg = { ...validConfig, companions: [{ id: "companion-a", role: "companion", vault_folder: "Companions/a/" }] };
    const tmpFile = join(tmpdir(), "test-config2.json");
    writeFileSync(tmpFile, JSON.stringify(cfg));
    const loaded = loadConfig(tmpFile);
    expect(loaded.companions).toHaveLength(1);
    expect(loaded.companions[0].id).toBe("companion-a");
    unlinkSync(tmpFile);
  });

  it("throws on invalid config", () => {
    const tmpFile = join(tmpdir(), "bad-config.json");
    writeFileSync(tmpFile, JSON.stringify({ invalid: true }));
    expect(() => loadConfig(tmpFile)).toThrow();
    unlinkSync(tmpFile);
  });

  it("throws when companion id is empty string", () => {
    const bad = { ...validConfig, companions: [{ id: "", role: "companion", vault_folder: "x/" }] };
    const tmpFile = join(tmpdir(), "bad2.json");
    writeFileSync(tmpFile, JSON.stringify(bad));
    expect(() => loadConfig(tmpFile)).toThrow();
    unlinkSync(tmpFile);
  });

  it("throws with helpful message when config file not found", () => {
    expect(() => loadConfig("/tmp/does-not-exist-abc123.json"))
      .toThrow("Config file not found");
  });

  it("throws with helpful message when config contains invalid JSON", () => {
    const tmpFile = join(tmpdir(), "invalid-json-test.json");
    writeFileSync(tmpFile, "{ invalid json }");
    expect(() => loadConfig(tmpFile)).toThrow("invalid JSON");
    unlinkSync(tmpFile);
  });
});
