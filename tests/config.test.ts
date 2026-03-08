import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, unlinkSync } from "fs";

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
    writeFileSync("/tmp/test-config.json", JSON.stringify(validConfig));
    const loaded = loadConfig("/tmp/test-config.json");
    expect(loaded.vault.adapter).toBe("filesystem");
    expect(loaded.companions).toHaveLength(0);
    expect(loaded.triggers.on_demand).toBe(true);
    unlinkSync("/tmp/test-config.json");
  });

  it("loads config with companions", () => {
    const cfg = { ...validConfig, companions: [{ id: "companion-a", role: "companion", vault_folder: "Companions/a/" }] };
    writeFileSync("/tmp/test-config2.json", JSON.stringify(cfg));
    const loaded = loadConfig("/tmp/test-config2.json");
    expect(loaded.companions).toHaveLength(1);
    expect(loaded.companions[0].id).toBe("companion-a");
    unlinkSync("/tmp/test-config2.json");
  });

  it("throws on invalid config", () => {
    writeFileSync("/tmp/bad-config.json", JSON.stringify({ invalid: true }));
    expect(() => loadConfig("/tmp/bad-config.json")).toThrow();
    unlinkSync("/tmp/bad-config.json");
  });

  it("throws when companion id is empty string", () => {
    const bad = { ...validConfig, companions: [{ id: "", role: "companion", vault_folder: "x/" }] };
    writeFileSync("/tmp/bad2.json", JSON.stringify(bad));
    expect(() => loadConfig("/tmp/bad2.json")).toThrow();
    unlinkSync("/tmp/bad2.json");
  });
});
