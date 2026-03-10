import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const tmpPath = join(process.cwd(), "test-config-tmp.json");

function writeConfig(obj: unknown) {
  writeFileSync(tmpPath, JSON.stringify(obj), "utf-8");
}

function cleanup() {
  try { unlinkSync(tmpPath); } catch {}
}

const baseConfig = {
  vault: { adapter: "filesystem", path: "/tmp/vault" },
  halseth: { url: "https://example.workers.dev", secret: "s" },
  plural: { enabled: false },
  companions: [{ id: "a", role: "companion", vault_folder: "a/" }],
  triggers: {
    scheduled: { enabled: false, cron: "0 22 * * *" },
    on_demand: true,
    event_driven: { enabled: false, on_session_close: false, on_handover: false },
  },
  routing: [],
  patterns: { enabled: false, hearth_summary: false },
  embeddings: { provider: "openai", model: "text-embedding-3-small", api_key: "k" },
};

describe("loadConfig - http block", () => {
  it("loads config without http block (http is optional)", () => {
    writeConfig(baseConfig);
    const config = loadConfig(tmpPath);
    expect(config.http).toBeUndefined();
    cleanup();
  });

  it("loads config with http block", () => {
    writeConfig({ ...baseConfig, http: { port: 3001, api_key: "secret" } });
    const config = loadConfig(tmpPath);
    expect(config.http?.port).toBe(3001);
    expect(config.http?.api_key).toBe("secret");
    cleanup();
  });

  it("rejects http block with invalid port", () => {
    writeConfig({ ...baseConfig, http: { port: "not-a-number", api_key: "secret" } });
    expect(() => loadConfig(tmpPath)).toThrow();
    cleanup();
  });
});

describe("loadConfig - couchdb block", () => {
  it("loads config without couchdb block (optional)", () => {
    writeConfig(baseConfig);
    const config = loadConfig(tmpPath);
    expect(config.couchdb).toBeUndefined();
    cleanup();
  });

  it("loads config with couchdb block", () => {
    writeConfig({ ...baseConfig, couchdb: { url: "http://localhost:5984", db: "obsidian-vault", username: "admin", password: "pass" } });
    const config = loadConfig(tmpPath);
    expect(config.couchdb?.db).toBe("obsidian-vault");
    cleanup();
  });

  it("rejects couchdb block with missing url", () => {
    writeConfig({ ...baseConfig, couchdb: { db: "obsidian-vault", username: "admin", password: "pass" } });
    expect(() => loadConfig(tmpPath)).toThrow();
    cleanup();
  });
});
