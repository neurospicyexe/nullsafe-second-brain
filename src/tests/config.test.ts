import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

function makeTmp() {
  return join(tmpdir(), `second-brain-test-${randomUUID()}.json`);
}

function writeConfig(obj: unknown, path: string) {
  writeFileSync(path, JSON.stringify(obj), "utf-8");
}

function cleanup(path: string) {
  try { unlinkSync(path); } catch {}
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
    const p = makeTmp(); writeConfig(baseConfig, p);
    const config = loadConfig(p);
    expect(config.http).toBeUndefined();
    cleanup(p);
  });

  it("loads config with http block", () => {
    const p = makeTmp(); writeConfig({ ...baseConfig, http: { port: 3001, api_key: "secret" } }, p);
    const config = loadConfig(p);
    expect(config.http?.port).toBe(3001);
    expect(config.http?.api_key).toBe("secret");
    cleanup(p);
  });

  it("rejects http block with invalid port", () => {
    const p = makeTmp(); writeConfig({ ...baseConfig, http: { port: "not-a-number", api_key: "secret" } }, p);
    expect(() => loadConfig(p)).toThrow();
    cleanup(p);
  });
});

describe("loadConfig - couchdb block", () => {
  it("loads config without couchdb block (optional)", () => {
    const p = makeTmp(); writeConfig(baseConfig, p);
    const config = loadConfig(p);
    expect(config.couchdb).toBeUndefined();
    cleanup(p);
  });

  it("loads config with couchdb block", () => {
    const p = makeTmp(); writeConfig({ ...baseConfig, couchdb: { url: "http://localhost:5984", db: "obsidian-vault", username: "admin", password: "pass" } }, p);
    const config = loadConfig(p);
    expect(config.couchdb?.db).toBe("obsidian-vault");
    cleanup(p);
  });

  it("rejects couchdb block with missing url", () => {
    const p = makeTmp(); writeConfig({ ...baseConfig, couchdb: { db: "obsidian-vault", username: "admin", password: "pass" } }, p);
    expect(() => loadConfig(p)).toThrow();
    cleanup(p);
  });
});
