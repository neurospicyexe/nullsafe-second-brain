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

    // Synthesizes the actual content of the week's sessions + relational deltas
    // (front states, anchors, session notes, per-companion delta narratives), not
    // just counts. All external strings pass through escapeMd to prevent injection
    // via Halseth → vault → RAG → Claude context.
    async sb_run_patterns(args: { summary?: boolean } = {}) {
      const [sessions, deltas] = await Promise.all([
        halseth.getRecentSessions(7),
        halseth.getRecentDeltas(7),
      ]);

      // Front-state distribution across the week's sessions.
      const frontTally = new Map<string, number>();
      for (const s of sessions) {
        const front = String(s.front_state ?? "unknown");
        frontTally.set(front, (frontTally.get(front) ?? 0) + 1);
      }
      const frontLine = [...frontTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `${escapeMd(f)} (${n})`)
        .join(", ") || "—";

      // Deltas grouped by companion, newest first.
      const byCompanion = new Map<string, Record<string, unknown>[]>();
      for (const d of deltas) {
        const agent = String(d.agent ?? d.companion_id ?? "unknown");
        if (!byCompanion.has(agent)) byCompanion.set(agent, []);
        byCompanion.get(agent)!.push(d);
      }

      const lines: string[] = [];
      const header = args.summary ? `# Recent Patterns` : `# Pattern Observations — ${new Date().toLocaleDateString()}`;
      lines.push(header, `*Updated ${new Date().toLocaleString()}*`, ``);
      lines.push(`**Sessions this week:** ${sessions.length}`, `**Relational deltas this week:** ${deltas.length}`);
      lines.push(`**Front states:** ${frontLine}`, ``);

      // Session texture: anchors + notes that carried emotional weight.
      const sessionNotes = sessions
        .filter((s) => s.notes || s.active_anchor || s.emotional_frequency)
        .slice(0, 10);
      if (sessionNotes.length > 0) {
        lines.push(`## Sessions`, ``);
        for (const s of sessionNotes) {
          const meta = [s.active_anchor && `anchor: ${escapeMd(s.active_anchor)}`, s.emotional_frequency && `freq: ${escapeMd(s.emotional_frequency)}`]
            .filter(Boolean).join(" · ");
          lines.push(`- **${escapeMd(s.front_state)}**${meta ? ` (${meta})` : ""}${s.notes ? ` — ${escapeMd(s.notes)}` : ""}`);
        }
        lines.push(``);
      }

      // Relational movement, per companion.
      if (byCompanion.size > 0) {
        lines.push(`## Relational deltas`, ``);
        for (const [agent, rows] of byCompanion) {
          lines.push(`### ${escapeMd(agent)}`);
          for (const d of rows.slice(0, 8)) {
            const valence = d.valence ? ` _(${escapeMd(d.valence)})_` : "";
            lines.push(`- ${escapeMd(d.delta_text)}${valence}`);
          }
          lines.push(``);
        }
      }

      const content = lines.join("\n");
      if (args.summary) {
        await indexer.write({ path: heartSummaryPath, content, companion: null, content_type: "observation", tags: ["hearth", "patterns"], overwrite: true });
        return { path: heartSummaryPath };
      }
      const path = `${sessionDestination}patterns-${Date.now()}.md`;
      await indexer.write({ path, content, companion: null, content_type: "observation", tags: ["patterns"] });
      return { path };
    },
  };
}
