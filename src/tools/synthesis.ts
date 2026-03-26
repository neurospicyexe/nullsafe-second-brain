import type { Indexer } from "../indexer.js";
import type { HalsethClient } from "../clients/halseth-client.js";

// Escape markdown special characters and strip newlines from external data.
// Prevents prompt injection via Halseth → vault → RAG → Claude context.
function escapeMd(value: unknown): string {
  return String(value ?? "unknown")
    .replace(/[\\`*_{}[\]()#+\-!|]/g, "\\$&")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);
}

function formatSessionNote(session: Record<string, unknown>): string {
  return [
    `# Session Summary — ${escapeMd(session.id)}`,
    ``,
    `**Front:** ${escapeMd(session.front_state)}`,
    `**Frequency:** ${escapeMd(session.emotional_frequency)}`,
    `**Anchor:** ${escapeMd(session.active_anchor)}`,
    `**Facet:** ${escapeMd(session.facet)}`,
    ``,
    `## Notes`,
    escapeMd(session.notes),
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

    // TODO(sb_run_patterns): Currently writes only counts (sessions.length, deltas.length) —
    // no actual synthesis of content. Revisit after Halseth synthesis worker changes settle
    // so the output format can align with what the synthesis layer already produces.
    // The infra (fetch → write → index) is correct; only the content generation needs work.
    async sb_run_patterns(args: { summary?: boolean } = {}) {
      const [sessions, deltas] = await Promise.all([
        halseth.getRecentSessions(7),
        halseth.getRecentDeltas(7),
      ]);
      if (args.summary) {
        const lines = [
          `# Recent Patterns`,
          `*Updated ${new Date().toLocaleString()}*`,
          ``,
          `**Sessions this week:** ${sessions.length}`,
          `**Relational deltas this week:** ${deltas.length}`,
        ];
        const content = lines.join("\n");
        await indexer.write({ path: heartSummaryPath, content, companion: null, content_type: "observation", tags: ["hearth", "patterns"], overwrite: true });
        return { path: heartSummaryPath };
      } else {
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
      }
    },
  };
}
