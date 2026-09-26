/**
 * Retract one discord-live document from the vector store (2026-09-26).
 *
 * WHY: POST /ingest/discord indexes companion replies unconditionally ("they have always been
 * indexed regardless"). On 2026-09-26 a fabricated blood-sugar number in Drevan's reply became a
 * top-ranked vault hit within seconds (score 0.73, above the true capture) and was served back to
 * him on the next question. The store could delete a path (deleteByPath) but nothing exposed it,
 * so a wrong memory could only be removed by hand on the box. This is the seam the bots'
 * `retract` command calls.
 *
 * Scope is the discord-live layer ONLY. It is the ephemeral recency lane (7-day TTL, no vault
 * file); the vault proper is canon and is not touched by this route.
 */

export function discordLivePath(channelId: string | undefined, messageId: string): string {
  const chan = typeof channelId === "string" && channelId ? channelId : "unknown";
  return `discord-live/${chan}/${messageId}.md`;
}

export type RetractParse = { path: string } | { error: string };

export function parseRetractBody(body: unknown): RetractParse {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const vp = typeof b["vault_path"] === "string" ? b["vault_path"].trim() : "";
  const mid = typeof b["message_id"] === "string" ? b["message_id"].trim() : "";
  const cid = typeof b["channel_id"] === "string" ? b["channel_id"].trim() : undefined;
  const path = vp || (mid ? discordLivePath(cid, mid) : "");
  if (!path) return { error: "message_id (with channel_id) or vault_path is required" };
  if (!path.startsWith("discord-live/") || path.includes("..")) {
    return { error: "retract only reaches the discord-live layer; the vault proper is not retractable here" };
  }
  return { path };
}
