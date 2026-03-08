export type VaultAdapter = "filesystem" | "obsidian-rest";
export type ContentType = "document" | "note" | "study" | "observation" | "session_summary";
export type CompanionRole = "companion" | "audit" | "seal" | string;

export interface CompanionConfig {
  id: string;
  role: CompanionRole;
  vault_folder: string;
}

export interface RoutingRule {
  companion?: string;
  tag?: string;
  type?: ContentType;
  subject_field?: boolean;
  destination: string;
}

export interface SecondBrainConfig {
  vault: {
    adapter: VaultAdapter;
    path: string;
  };
  obsidian_rest?: {
    url: string;
    api_key: string;
  };
  halseth: {
    url: string;
    secret: string;
  };
  plural: {
    enabled: boolean;
    mcp_url?: string;
  };
  companions: CompanionConfig[];
  triggers: {
    scheduled: { enabled: boolean; cron: string };
    on_demand: boolean;
    event_driven: { enabled: boolean; on_session_close: boolean; on_handover: boolean };
  };
  routing: RoutingRule[];
  patterns: {
    enabled: boolean;
    hearth_summary: boolean;
    hearth_summary_path: string;
  };
  embeddings: {
    provider: "openai" | "ollama";
    model: string;
    api_key?: string;
    ollama_url?: string;
  };
}
