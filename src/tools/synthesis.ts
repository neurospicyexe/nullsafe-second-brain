import type { Indexer } from "../indexer.js";
import type { HalsethClient } from "../clients/halseth-client.js";

function formatSessionNote(session: Record<string, unknown>): string {
  return [
    `# Session Summary — ${String(session.id)}`,
    ``,
    `**Front:** ${String(session.front_state ?? "unknown")}`,
    `**Frequency:** ${String(session.emotional_frequency ?? "not recorded")}`,
    `**Anchor:** ${String(session.active_anchor ?? "none")}`,
    `**Facet:** ${String(session.facet ?? "none")}`,
    ``,
    `## Notes`,
    String(session.notes ?? "No notes recorded."),
  ].join("\n");
}

export function buildSynthesisTools(
  indexer: Indexer,
  halseth: HalsethClient,
  sessionDestination: string,
  heartSummaryPath: string,
) {
  return {
    async sb_synthesize_session(args: { session_id: string }) {
      const session = await halseth.getSession(args.session_id) as Record<string, unknown>;
      const content = formatSessionNote(session);
      const path = `${sessionDestination}session-${args.session_id}.md`;
      await indexer.write({ path, content, companion: null, content_type: "session_summary", tags: ["session"] });
      return { path };
    },

    async sb_run_patterns() {
      const [sessions, deltas] = await Promise.all([
        halseth.getRecentSessions(7),
        halseth.getRecentDeltas(7),
      ]);
      const lines = [
        `# Pattern Observations — ${new Date().toLocaleDateString()}`,
        ``,
        `**Sessions this week:** ${sessions.length}`,
        `**Relational deltas this week:** ${deltas.length}`,
      ];
      const content = lines.join("\n");
      const path = `${sessionDestination}patterns-${Date.now()}.md`;
      await indexer.write({ path, content, companion: null, content_type: "observation", tags: ["patterns"] });
      return { path };
    },

    async sb_write_pattern_summary() {
      const sessions = await halseth.getRecentSessions(7);
      const lines = [
        `# Recent Patterns`,
        `*Updated ${new Date().toLocaleString()}*`,
        ``,
        `**Sessions this week:** ${sessions.length}`,
      ];
      const content = lines.join("\n");
      await indexer.write({ path: heartSummaryPath, content, companion: null, content_type: "observation", tags: ["hearth", "patterns"], overwrite: true });
      return { path: heartSummaryPath };
    },
  };
}
