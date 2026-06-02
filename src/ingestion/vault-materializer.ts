// src/ingestion/vault-materializer.ts
//
// Bridges Halseth growth tables (D1) into the Obsidian vault as structured
// .md files. This is the "transfer" the autonomous worker has been missing:
// growth_journal/patterns/markers rows existed only in D1, never as files
// the human (or future companion sessions) could open and read.
//
// Cron flow (every VAULT_MATERIALIZER_CRON, default 30 min):
//   1. For each companion: GET /mind/growth/unmaterialized/:companion_id
//   2. For each row: format frontmatter + body, write via VaultAdapter under
//      Companions/<id>/growth/{journal,patterns,markers}/.
//   3. PATCH /mind/growth/<kind>/<id>/vault with the relative vault path.
//
// All writes are idempotent at the Halseth side: once vault_path is set, the
// row no longer appears in the unmaterialized response, so re-runs cost
// nothing. If the vault adapter fails (Obsidian closed, tunnel down), the
// ObsidianRestAdapter's offline write queue takes over and the materializer
// just doesn't PATCH vault_path on those rows -- they retry next tick.

import type { IngestionConfig } from "./types.js";
import type { SecondBrainConfig } from "../config.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";
import { FilesystemAdapter } from "../adapters/filesystem-adapter.js";
import { ObsidianRestAdapter } from "../adapters/obsidian-rest-adapter.js";
import { CouchDBAdapter } from "../adapters/couchdb-adapter.js";

const COMPANIONS = ["cypher", "drevan", "gaia"] as const;
type CompanionId = typeof COMPANIONS[number];

interface UnmaterializedJournal {
  id: string;
  entry_type: string;
  content: string;
  tags_json: string;
  source: string;
  created_at: string;
  prehended_ids: string;   // JSON array
  evidence_json: string;   // JSON array
  novelty: string | null;
}
interface UnmaterializedPattern {
  id: string;
  pattern_text: string;
  evidence_json: string;
  strength: number;
  prehended_ids: string;
  created_at: string;
  updated_at: string;
}
interface UnmaterializedMarker {
  id: string;
  marker_type: string;
  description: string;
  related_pattern_id: string | null;
  prehended_ids: string;
  created_at: string;
}
interface UnmaterializedResponse {
  journal:  UnmaterializedJournal[];
  patterns: UnmaterializedPattern[];
  markers:  UnmaterializedMarker[];
  // Journal rows that carry a vault_path but are no longer canon (pending or
  // declined). Their .md files must be removed from the vault.
  orphaned: Array<{ id: string; vault_path: string }>;
}

interface Evidence {
  quote: string;
  source_url?: string;
  source_id?: string;
  source_companion?: string;
}

/**
 * Build a VaultAdapter from SecondBrainConfig. Mirrors server.ts adapter
 * precedence (obsidian-rest > couchdb > filesystem) so the materializer
 * always writes through the same surface as the rest of the system.
 */
export function buildVaultAdapter(config: SecondBrainConfig): VaultAdapter {
  if (config.vault.adapter === "obsidian-rest") {
    if (!config.obsidian_rest) {
      throw new Error('vault.adapter is "obsidian-rest" but obsidian_rest config is missing.');
    }
    return new ObsidianRestAdapter({
      url: config.obsidian_rest.url,
      apiKey: config.obsidian_rest.api_key,
    });
  }
  if (config.couchdb) {
    return new CouchDBAdapter(config.couchdb);
  }
  return new FilesystemAdapter(config.vault.path);
}

/**
 * Resolves a halseth row id to a vault wikilink. Two-tier lookup:
 *   1. sameTickPaths -- rows being materialized in the current tick. Their
 *      target paths are computed up front so cross-references inside one
 *      batch resolve cleanly even though the rows haven't been written yet.
 *   2. crossTickPaths -- vault_paths fetched via POST /mind/growth/vault-paths
 *      for any prehended ids not in this tick's batch (typically peer rows
 *      or rows from prior ticks).
 *
 * Falls back to the dangling [[halseth/<id>]] form when unresolved.
 */
type WikilinkResolver = (id: string) => string;

function buildResolver(
  sameTickPaths: Map<string, string>,
  crossTickPaths: Record<string, string | null>,
): WikilinkResolver {
  return (id: string) => {
    const sameTick = sameTickPaths.get(id);
    if (sameTick) return formatWikilink(sameTick, id);
    const crossTick = crossTickPaths[id];
    if (crossTick) return formatWikilink(crossTick, id);
    // Unresolved -- still emit something parseable so future scans can pick it up.
    return `[[halseth/${id}]]`;
  };
}

function formatWikilink(vaultPath: string, id: string): string {
  // Obsidian wikilinks omit the .md extension. Display label is the file
  // name without extension so the link reads as a human title rather than
  // a UUID.
  const noExt = vaultPath.replace(/\.md$/i, "");
  const display = noExt.split("/").pop() ?? id;
  return `[[${noExt}|${display}]]`;
}

/**
 * Single materializer tick. For each companion, pull unmaterialized rows
 * and write a vault file per row. Returns counts for logging / cron health.
 *
 * Wikilink resolution flow:
 *   1. Pull all unmaterialized rows for all three companions.
 *   2. Compute the target vault path for every row up front.
 *   3. Collect every prehended_id mentioned by any row, minus the ids in
 *      this tick's batch (those are in the same-tick map).
 *   4. POST those leftover ids to /mind/growth/vault-paths to resolve any
 *      that were materialized in prior ticks (or are peer rows already on disk).
 *   5. Render each row with a resolver that consults both maps.
 */
export async function runVaultMaterializer(
  ingestionConfig: IngestionConfig,
  vault: VaultAdapter,
): Promise<{ written: number; failed: number; skipped: number; perCompanion: Record<string, number> }> {
  let totalWritten = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const perCompanion: Record<string, number> = {};

  // Pull all three companions up front so the same-tick path map covers
  // cross-companion prehensions (e.g. cypher's new entry prehends a drevan
  // entry that's also being materialized in this tick).
  type Item = { companionId: CompanionId; kind: "journal" | "patterns" | "markers"; row: any; targetPath: string };
  const allItems: Item[] = [];
  const orphanedItems: Array<{ companionId: CompanionId; id: string; vaultPath: string }> = [];
  for (const companionId of COMPANIONS) {
    try {
      const data = await fetchUnmaterialized(ingestionConfig, companionId);
      for (const r of data.journal)  allItems.push({ companionId, kind: "journal",  row: r, targetPath: computeJournalPath(companionId, r) });
      for (const r of data.patterns) allItems.push({ companionId, kind: "patterns", row: r, targetPath: computePatternPath(companionId, r) });
      for (const r of data.markers)  allItems.push({ companionId, kind: "markers",  row: r, targetPath: computeMarkerPath(companionId, r) });
      for (const o of data.orphaned ?? []) orphanedItems.push({ companionId, id: o.id, vaultPath: o.vault_path });
    } catch (e) {
      console.error(`[vault-materializer] ${companionId} pull failed:`, e instanceof Error ? e.message : e);
    }
  }

  // Un-materialize orphans first: rows written to the vault that are no longer
  // canon (pending or declined). Delete the file, THEN clear vault_path -- if the
  // clear fails it just retries next tick rather than leaving a row pointing at a
  // deleted file. Keeps the vault holding only ratified growth. Runs even when
  // there is nothing new to materialize.
  let totalCleaned = 0;
  for (const o of orphanedItems) {
    try {
      await vault.delete(o.vaultPath);
      if (await clearVaultPath(ingestionConfig, "journal", o.id)) totalCleaned++;
    } catch (e) {
      console.warn(`[vault-materializer] orphan cleanup ${o.companionId}/${o.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
  if (orphanedItems.length > 0) {
    console.log(`[vault-materializer] orphan cleanup: ${totalCleaned}/${orphanedItems.length} un-materialized (file deleted + vault_path cleared)`);
  }

  if (allItems.length === 0) {
    for (const c of COMPANIONS) perCompanion[c] = 0;
    console.log(`[vault-materializer] complete: nothing to materialize`);
    return { written: 0, failed: 0, skipped: 0, perCompanion };
  }

  const sameTickPaths = new Map<string, string>();
  for (const item of allItems) sameTickPaths.set(item.row.id, item.targetPath);

  // Collect prehended ids referenced by any row, excluding ones already in
  // this tick's batch.
  const referenced = new Set<string>();
  for (const item of allItems) {
    for (const id of parseJsonArray<string>(item.row.prehended_ids)) {
      if (typeof id === "string" && id.length > 0 && !sameTickPaths.has(id)) referenced.add(id);
    }
  }

  let crossTickPaths: Record<string, string | null> = {};
  if (referenced.size > 0) {
    crossTickPaths = await fetchVaultPaths(ingestionConfig, Array.from(referenced));
  }

  const resolver = buildResolver(sameTickPaths, crossTickPaths);

  // Group counts per companion for logging.
  const perCompanionInputCounts: Record<string, { journal: number; patterns: number; markers: number }> = {};
  for (const c of COMPANIONS) perCompanionInputCounts[c] = { journal: 0, patterns: 0, markers: 0 };
  for (const item of allItems) perCompanionInputCounts[item.companionId][item.kind]++;
  for (const c of COMPANIONS) {
    const cnt = perCompanionInputCounts[c];
    if (cnt.journal + cnt.patterns + cnt.markers === 0) {
      console.log(`[vault-materializer] ${c}: nothing to materialize`);
      perCompanion[c] = 0;
    } else {
      console.log(`[vault-materializer] ${c}: ${cnt.journal} journal, ${cnt.patterns} patterns, ${cnt.markers} markers`);
      perCompanion[c] = 0;
    }
  }

  for (const item of allItems) {
    try {
      const content = renderRow(item.companionId, item.kind, item.row, resolver);
      await vault.write({ path: item.targetPath, content, overwrite: true });
      const patchOk = await patchVaultPath(ingestionConfig, item.kind, item.row.id, item.targetPath);
      if (patchOk) {
        totalWritten++;
        perCompanion[item.companionId]++;
      } else {
        totalSkipped++;
      }
    } catch (e) {
      totalFailed++;
      console.warn(`[vault-materializer] ${item.companionId}/${item.kind}/${item.row.id} failed:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`[vault-materializer] complete: written=${totalWritten} failed=${totalFailed} skipped=${totalSkipped}`);
  return { written: totalWritten, failed: totalFailed, skipped: totalSkipped, perCompanion };
}

async function fetchVaultPaths(config: IngestionConfig, ids: string[]): Promise<Record<string, string | null>> {
  try {
    const res = await fetch(`${config.halsethUrl}/mind/growth/vault-paths`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.halsethSecret}`,
      },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[vault-materializer] vault-paths lookup ${res.status}; wikilinks may dangle this tick`);
      return {};
    }
    const data = await res.json() as { paths?: Record<string, string | null> };
    return data.paths ?? {};
  } catch (e) {
    console.warn(`[vault-materializer] vault-paths lookup failed:`, e instanceof Error ? e.message : e);
    return {};
  }
}

async function fetchUnmaterialized(config: IngestionConfig, companionId: CompanionId): Promise<UnmaterializedResponse> {
  const res = await fetch(
    `${config.halsethUrl}/mind/growth/unmaterialized/${encodeURIComponent(companionId)}?limit=100`,
    {
      headers: { "Authorization": `Bearer ${config.halsethSecret}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Halseth GET unmaterialized → ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json() as UnmaterializedResponse;
}

async function patchVaultPath(
  config: IngestionConfig,
  kind: "journal" | "patterns" | "markers",
  id: string,
  vaultPath: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.halsethUrl}/mind/growth/${kind}/${encodeURIComponent(id)}/vault`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.halsethSecret}`,
        },
        body: JSON.stringify({ vault_path: vaultPath }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[vault-materializer] PATCH vault_path failed ${kind}/${id}: ${res.status} ${text.slice(0, 100)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[vault-materializer] PATCH vault_path threw ${kind}/${id}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Clear vault_path back to NULL (un-materialization). PATCH with vault_path:null.
async function clearVaultPath(
  config: IngestionConfig,
  kind: "journal" | "patterns" | "markers",
  id: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.halsethUrl}/mind/growth/${kind}/${encodeURIComponent(id)}/vault`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.halsethSecret}`,
        },
        body: JSON.stringify({ vault_path: null }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[vault-materializer] clear vault_path failed ${kind}/${id}: ${res.status} ${text.slice(0, 100)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[vault-materializer] clear vault_path threw ${kind}/${id}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// .md rendering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Path computation -- pure, called up front to build the same-tick path map
// before any rendering. Rendering then takes a resolver that knows about
// these paths.
// ---------------------------------------------------------------------------

function computeJournalPath(companionId: CompanionId, r: UnmaterializedJournal): string {
  const date = r.created_at.slice(0, 10);
  const slug = slugify(firstSentence(r.content)) || `entry-${r.id.slice(0, 8)}`;
  return `Companions/${companionId}/growth/journal/${date}-${slug}.md`;
}
function computePatternPath(companionId: CompanionId, r: UnmaterializedPattern): string {
  const slug = slugify(r.pattern_text) || `pattern-${r.id.slice(0, 8)}`;
  return `Companions/${companionId}/growth/patterns/${slug}.md`;
}
function computeMarkerPath(companionId: CompanionId, r: UnmaterializedMarker): string {
  const date = r.created_at.slice(0, 10);
  const slug = slugify(r.description) || `marker-${r.id.slice(0, 8)}`;
  return `Companions/${companionId}/growth/markers/${date}-${r.marker_type}-${slug}.md`;
}

function renderRow(
  companionId: CompanionId,
  kind: "journal" | "patterns" | "markers",
  row: UnmaterializedJournal | UnmaterializedPattern | UnmaterializedMarker,
  resolver: WikilinkResolver,
): string {
  if (kind === "journal") {
    return renderJournal(companionId, row as UnmaterializedJournal, resolver);
  }
  if (kind === "patterns") {
    return renderPattern(companionId, row as UnmaterializedPattern, resolver);
  }
  return renderMarker(companionId, row as UnmaterializedMarker, resolver);
}

function renderJournal(companionId: CompanionId, r: UnmaterializedJournal, resolver: WikilinkResolver): string {
  const tags = parseJsonArray<string>(r.tags_json);
  const evidence = parseJsonArray<Evidence>(r.evidence_json);
  const prehended = parseJsonArray<string>(r.prehended_ids);

  const fm = frontmatter({
    type: "growth_journal",
    companion: companionId,
    entry_type: r.entry_type,
    novelty: r.novelty ?? "unset",
    source: r.source,
    created_at: r.created_at,
    tags: tags.concat(["growth", "growth-journal", `companion/${companionId}`, ...(r.novelty ? [`novelty/${r.novelty}`] : [])]),
    halseth_id: r.id,
  });

  const lines: string[] = [];
  lines.push(fm);
  lines.push(`# ${capitalize(r.entry_type)}: ${firstSentence(r.content) || "(untitled)"}`);
  lines.push("");
  lines.push(r.content.trim());
  lines.push("");
  if (evidence.length > 0) {
    lines.push("## Evidence");
    for (const e of evidence) lines.push(formatEvidence(e));
    lines.push("");
  }
  if (prehended.length > 0) {
    lines.push("## Prehended");
    for (const id of prehended) lines.push(`- ${resolver(id)}`);
    lines.push("");
  }
  lines.push("---");
  lines.push(`*halseth row \`${r.id}\` -- materialized by vault-materializer*`);

  return lines.join("\n");
}

function renderPattern(companionId: CompanionId, r: UnmaterializedPattern, resolver: WikilinkResolver): string {
  const evidence  = parseJsonArray<Evidence>(r.evidence_json);
  const prehended = parseJsonArray<string>(r.prehended_ids);

  const fm = frontmatter({
    type: "growth_pattern",
    companion: companionId,
    strength: r.strength,
    created_at: r.created_at,
    updated_at: r.updated_at,
    tags: ["growth", "growth-pattern", `companion/${companionId}`, `strength/${r.strength}`],
    halseth_id: r.id,
  });

  const lines: string[] = [];
  lines.push(fm);
  lines.push(`# Pattern: ${r.pattern_text}`);
  lines.push("");
  lines.push(`**Strength:** ${r.strength}/10`);
  lines.push("");
  if (evidence.length > 0) {
    lines.push("## Evidence (accumulating across runs)");
    for (const e of evidence) lines.push(formatEvidence(e));
    lines.push("");
  }
  if (prehended.length > 0) {
    lines.push("## Crystallized from");
    for (const id of prehended) lines.push(`- ${resolver(id)}`);
    lines.push("");
  }
  lines.push("---");
  lines.push(`*halseth row \`${r.id}\`. Subsequent runs that surface a similar shape will MERGE into this row, incrementing strength and accumulating evidence.*`);

  return lines.join("\n");
}

function renderMarker(companionId: CompanionId, r: UnmaterializedMarker, resolver: WikilinkResolver): string {
  const prehended = parseJsonArray<string>(r.prehended_ids);

  const fm = frontmatter({
    type: "growth_marker",
    companion: companionId,
    marker_type: r.marker_type,
    created_at: r.created_at,
    tags: ["growth", "growth-marker", `marker-type/${r.marker_type}`, `companion/${companionId}`],
    halseth_id: r.id,
  });

  const lines: string[] = [];
  lines.push(fm);
  lines.push(`# ${capitalize(r.marker_type)}: ${firstSentence(r.description) || "(untitled)"}`);
  lines.push("");
  lines.push(r.description.trim());
  lines.push("");
  if (r.marker_type === "thoughtform" && prehended.length > 0) {
    lines.push("## Cross-companion crystallization");
    lines.push("This thoughtform exists because more than one companion independently surfaced the same shape. The patterns below are its constituents:");
    lines.push("");
    for (const id of prehended) lines.push(`- ${resolver(id)}`);
  } else if (prehended.length > 0) {
    lines.push("## Prehended");
    for (const id of prehended) lines.push(`- ${resolver(id)}`);
  }
  lines.push("");
  lines.push("---");
  lines.push(`*halseth row \`${r.id}\`*`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseJsonArray<T>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else if (v !== null && v !== undefined) {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

function yamlScalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // Quote if contains chars that confuse YAML or starts with a sigil.
  if (/[:#&*!|>%@`]/.test(s) || /^\s|\s$/.test(s) || s === "") {
    return JSON.stringify(s);
  }
  return s;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function firstSentence(s: string): string {
  const m = s.replace(/\s+/g, " ").trim().match(/^[^.!?\n]{1,140}([.!?]|$)/);
  return m ? m[0].trim() : s.replace(/\s+/g, " ").trim().slice(0, 140);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function formatEvidence(e: Evidence): string {
  const quote = (e.quote ?? "").replace(/\s+/g, " ").trim();
  const parts: string[] = [`> ${quote}`];
  const meta: string[] = [];
  if (e.source_companion) meta.push(`from ${e.source_companion}`);
  if (e.source_id)        meta.push(`row \`${e.source_id}\``);
  if (e.source_url)       meta.push(`<${e.source_url}>`);
  if (meta.length > 0) parts.push(`  -- ${meta.join(", ")}`);
  return parts.join("\n");
}

// (idToWikilink retired -- resolver in runVaultMaterializer now produces
// real Obsidian wikilinks via formatWikilink, falling back to the
// [[halseth/<id>]] form only for unresolved cross-tick references.)
