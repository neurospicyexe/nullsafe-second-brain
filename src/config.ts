import { readFileSync } from "fs";
import { z } from "zod";

const companionSchema = z.object({
  id: z.string().min(1),
  role: z.string(),
  vault_folder: z.string(),
});

const configSchema = z.object({
  vault: z.object({
    adapter: z.enum(["filesystem", "obsidian-rest"]),
    path: z.string(),
  }),
  obsidian_rest: z.object({ url: z.string(), api_key: z.string() }).optional(),
  halseth: z.object({ url: z.string(), secret: z.string() }),
  plural: z.object({ enabled: z.boolean(), mcp_url: z.string().optional() }),
  companions: z.array(companionSchema),
  triggers: z.object({
    scheduled: z.object({ enabled: z.boolean(), cron: z.string() }),
    on_demand: z.boolean(),
    event_driven: z.object({
      enabled: z.boolean(),
      on_session_close: z.boolean(),
      on_handover: z.boolean(),
    }),
  }),
  routing: z.array(z.object({
    companion: z.string().optional(),
    tag: z.string().optional(),
    type: z.string().optional(),
    subject_field: z.boolean().optional(),
    destination: z.string(),
  })),
  patterns: z.object({
    enabled: z.boolean(),
    hearth_summary: z.boolean(),
    hearth_summary_path: z.string(),
  }),
  embeddings: z.object({
    provider: z.enum(["openai", "ollama"]),
    model: z.string(),
    api_key: z.string().optional(),
    ollama_url: z.string().optional(),
  }),
});

export type SecondBrainConfig = z.infer<typeof configSchema>;

export function loadConfig(path = "second-brain.config.json"): SecondBrainConfig {
  let raw: unknown;
  try {
    const text = readFileSync(path, "utf-8");
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`Config file at "${path}" contains invalid JSON: ${(e as Error).message}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Config file not found at "${path}". Copy second-brain.config.example.json to second-brain.config.json and fill in your values.`);
    }
    throw e;
  }
  return configSchema.parse(raw);
}
