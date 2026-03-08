export type VaultAdapterType = "filesystem" | "obsidian-rest";
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

