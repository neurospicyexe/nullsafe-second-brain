// src/ingestion/inbox-filer.ts
//
// Autonomous INBOX auto-filer. Takes vault filing off Raziel's plate: notes that
// land in "00 - INBOX/" get classified (LLM) and moved to the right folder with a
// good name + frontmatter properties -- instead of Raziel renaming and moving
// everything by hand.
//
// Approved design (2026-06-13): HYBRID mode, INBOX-only.
//   - High-confidence notes (>= threshold) are auto-filed immediately.
//   - Uncertain notes are QUEUED into "00 - INBOX/_filing-plan.md" as checkbox
//     items. Raziel ticks [x] on the ones to approve; the next run applies the
//     checked moves (one-tap approval) and leaves the rest.
//   - Every move is logged to "00 - INBOX/_filing-log.md". Move-only, never
//     delete -- fully reversible.
//
// Safety: INBOX-scoped only (never touches already-filed notes). The control
// files (_filing-plan.md, _filing-log.md) are skipped. Clobber-safe: a name
// collision at the destination gets a numeric suffix, never an overwrite.

import type { VaultAdapter } from "../adapters/vault-adapter.js";

export type FilerMode = "hybrid" | "auto" | "suggest";

export const INBOX_FOLDER = "00 - INBOX/";
export const PLAN_FILE = `${INBOX_FOLDER}_filing-plan.md`;
export const LOG_FILE = `${INBOX_FOLDER}_filing-log.md`;
// Control files + anything starting with "_" or "." are never themselves filed.
const SKIP_BASENAMES = new Set(["_filing-plan.md", "_filing-log.md"]);

export interface FilingDecision {
  destination_folder: string;            // e.g. "Books/The-Overstory" (no leading slash)
  filename: string;                      // e.g. "Chapter 01.md"
  properties?: Record<string, string | string[]>;
  confidence: number;                    // 0..1
  reason: string;
}

export interface NoteForClassify {
  path: string;
  title: string;
  excerpt: string;
  folders: string[];                     // the vault's real top-level taxonomy
}

export interface InboxFilerDeps {
  vault: VaultAdapter;
  /** Classify one note -> a filing decision, or null if it can't decide. */
  classify: (note: NoteForClassify) => Promise<FilingDecision | null>;
  /** Keep the vector store consistent after a move (deleteByPath(from)+reindex(to)). */
  onMoved?: (from: string, to: string) => Promise<void> | void;
  now?: () => Date;
}

export interface FilerOptions {
  mode: FilerMode;
  dryRun: boolean;
  confidenceThreshold: number;           // hybrid: >= auto-file, < queue
}

export interface FilerStats {
  scanned: number;
  filed: number;     // auto-moved this run
  approved: number;  // checked plan items moved this run
  queued: number;    // newly written to the plan
  skipped: number;
  failed: number;
}

// ── pure helpers (exported for tests) ───────────────────────────────────────

/** Vault-safe filename: strip illegal chars, collapse whitespace, ensure .md. */
export function sanitizeFilename(name: string): string {
  let n = (name || "").trim().replace(/\.md$/i, "");
  n = n.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) n = "Untitled";
  return `${n.slice(0, 120)}.md`;
}

/** Top-level folder names from a vault listing (paths or bare names). */
export function topLevelFolders(entries: string[]): string[] {
  const folders = new Set<string>();
  for (const e of entries) {
    const seg = e.replace(/^\/+/, "").split("/").filter(Boolean)[0];
    if (!seg) continue;
    if (seg.startsWith("_") || seg.startsWith(".")) continue;
    // a bare file at root (has an extension and no nesting) is not a folder
    if (!e.includes("/") && /\.[a-z0-9]+$/i.test(seg)) continue;
    folders.add(seg);
  }
  return [...folders].sort();
}

export function parseVaultEntries(raw: string[] | null | undefined): string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
}

/** Merge frontmatter properties into a note's content (kepano properties style).
 *  Preserves an existing frontmatter block; adds only missing keys. */
export function applyProperties(content: string, props: Record<string, string | string[]>): string {
  if (!props || Object.keys(props).length === 0) return content;
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const render = (obj: Record<string, string | string[]>): string =>
    Object.entries(obj).map(([k, v]) =>
      Array.isArray(v) ? `${k}:\n${v.map(x => `  - ${x}`).join("\n")}` : `${k}: ${v}`
    ).join("\n");
  if (fmMatch) {
    const existingKeys = new Set([...fmMatch[1].matchAll(/^([A-Za-z0-9_-]+):/gm)].map(m => m[1]));
    const additions = Object.fromEntries(Object.entries(props).filter(([k]) => !existingKeys.has(k)));
    if (Object.keys(additions).length === 0) return content;
    const merged = `---\n${fmMatch[1]}\n${render(additions)}\n---\n`;
    return content.replace(fmMatch[0], merged);
  }
  return `---\n${render(props)}\n---\n\n${content}`;
}

/** A queued plan line: a checkbox the human ticks to approve the move. */
export function renderPlanLine(from: string, to: string, confidence: number, reason: string): string {
  return `- [ ] \`${from}\` → \`${to}\`  (${confidence.toFixed(2)}) — ${reason.replace(/\n/g, " ").slice(0, 200)}`;
}

/** Parse a plan file into items; checked = approved-to-move. */
export function parsePlan(planText: string): Array<{ from: string; to: string; checked: boolean }> {
  const out: Array<{ from: string; to: string; checked: boolean }> = [];
  for (const line of planText.split("\n")) {
    const m = line.match(/^- \[([ xX])\]\s+`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/);
    if (m) out.push({ checked: m[1].toLowerCase() === "x", from: m[2], to: m[3] });
  }
  return out;
}

function destPath(folder: string, filename: string): string {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return `${f}/${sanitizeFilename(filename)}`;
}

function isoDate(now: Date): string { return now.toISOString().slice(0, 10); }

// ── main ────────────────────────────────────────────────────────────────────

export async function runInboxFiler(deps: InboxFilerDeps, opts: FilerOptions): Promise<FilerStats> {
  const { vault, classify } = deps;
  const now = deps.now ?? (() => new Date());
  const stats: FilerStats = { scanned: 0, filed: 0, approved: 0, queued: 0, skipped: 0, failed: 0 };
  const logLines: string[] = [];

  const move = async (from: string, to: string, note: string): Promise<boolean> => {
    try {
      // clobber-safe: never overwrite an existing destination
      let finalTo = to;
      let i = 2;
      while (await vault.exists(finalTo).catch(() => false)) {
        finalTo = to.replace(/\.md$/i, ` ${i++}.md`);
      }
      if (!opts.dryRun) {
        await vault.move(from, finalTo);
        await deps.onMoved?.(from, finalTo);
      }
      logLines.push(`- ${isoDate(now())} ${opts.dryRun ? "[dry] " : ""}\`${from}\` → \`${finalTo}\` — ${note}`);
      return true;
    } catch (e) {
      stats.failed++;
      logLines.push(`- ${isoDate(now())} FAILED \`${from}\` → \`${to}\`: ${String(e).slice(0, 160)}`);
      return false;
    }
  };

  // 1. Apply any human-approved (checked) items from the existing plan first.
  let remainingPlan: string[] = [];
  try {
    const planText = await vault.read(PLAN_FILE).catch(() => "");
    if (planText) {
      for (const item of parsePlan(planText)) {
        if (item.checked) {
          if (await move(item.from, item.to, "approved from plan")) stats.approved++;
        } else {
          remainingPlan.push(renderPlanLine(item.from, item.to, 0, "carried over"));
        }
      }
    }
  } catch { /* no plan yet */ }

  // 2. Learn the real taxonomy + scan INBOX.
  const folders = topLevelFolders(parseVaultEntries(await vault.list("").catch(() => [])));
  const inboxEntries = parseVaultEntries(await vault.list(INBOX_FOLDER).catch(() => []))
    .filter(p => /\.md$/i.test(p))
    .filter(p => { const b = p.split("/").pop() ?? p; return !SKIP_BASENAMES.has(b) && !b.startsWith("_") && !b.startsWith("."); });

  const newPlanLines: string[] = [];
  for (const path of inboxEntries) {
    stats.scanned++;
    let content: string;
    try { content = await vault.read(path); }
    catch { stats.skipped++; continue; }
    const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
    const decision = await classify({ path, title, excerpt: content.slice(0, 1500), folders }).catch(() => null);
    if (!decision || !decision.destination_folder || decision.confidence <= 0) { stats.skipped++; continue; }

    const to = destPath(decision.destination_folder, decision.filename || title);
    const autoFile = opts.mode === "auto" || (opts.mode === "hybrid" && decision.confidence >= opts.confidenceThreshold);

    if (opts.mode === "suggest" || (opts.mode === "hybrid" && !autoFile)) {
      newPlanLines.push(renderPlanLine(path, to, decision.confidence, decision.reason));
      stats.queued++;
      continue;
    }
    // auto-file: stamp properties first (best-effort), then move
    if (!opts.dryRun && decision.properties) {
      try { await vault.write({ path, content: applyProperties(content, decision.properties), overwrite: true }); } catch { /* non-fatal */ }
    }
    if (await move(path, to, decision.reason)) stats.filed++;
  }

  // 3. Rewrite the plan (carried-over unchecked + newly queued).
  const planBody = [...remainingPlan, ...newPlanLines];
  if (!opts.dryRun) {
    const header = `# Filing plan\n\nTick \`[x]\` any line to approve the move; the filer applies checked items on its next run. Untouched lines are re-proposed. This file and \`_filing-log.md\` are never themselves filed.\n\n`;
    try {
      await vault.write({ path: PLAN_FILE, content: planBody.length ? header + planBody.join("\n") + "\n" : header + "_(nothing queued)_\n", overwrite: true });
    } catch { /* non-fatal */ }
    // 4. Append the log.
    if (logLines.length) {
      const prior = await vault.read(LOG_FILE).catch(() => "# Filing log\n");
      try { await vault.write({ path: LOG_FILE, content: `${prior.replace(/\n+$/, "")}\n${logLines.join("\n")}\n`, overwrite: true }); } catch { /* non-fatal */ }
    }
  }

  return stats;
}

/** Build the classifier prompt. Kept pure so the exact wording is testable. */
export function buildClassifyPrompt(note: NoteForClassify): string {
  return [
    "You are filing a note into an Obsidian vault. Decide the single best destination folder and a clean filename.",
    "",
    `Existing top-level folders (prefer one of these; you may name a sub-folder under one, e.g. "Books/The Overstory"): ${note.folders.join(", ") || "(none yet)"}`,
    "",
    `Note title: ${note.title}`,
    `Note excerpt:\n${note.excerpt}`,
    "",
    "Rules: filename in Title Case, no special characters; pick the folder by what the note IS (a book chapter -> Books/<Title>, a companion note -> companions/<id>, research -> rag or a topic folder). If you are NOT confident, give a low confidence -- do not force a folder.",
    "",
    'Respond ONLY with JSON: {"destination_folder":"<folder or folder/subfolder>","filename":"<Name>.md","properties":{"type":"<note|book|research|reference>","tags":["..."]},"confidence":0.0,"reason":"<one sentence>"}',
  ].join("\n");
}

/** Parse the classifier's JSON response. Returns null on anything malformed. */
export function parseDecision(raw: string): FilingDecision | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as Partial<FilingDecision>;
    if (typeof j.destination_folder !== "string" || !j.destination_folder.trim()) return null;
    const confidence = typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : 0;
    return {
      destination_folder: j.destination_folder.trim().replace(/^\/+|\/+$/g, ""),
      filename: typeof j.filename === "string" && j.filename.trim() ? j.filename.trim() : "Untitled.md",
      properties: (j.properties && typeof j.properties === "object") ? j.properties as Record<string, string | string[]> : undefined,
      confidence,
      reason: typeof j.reason === "string" ? j.reason : "",
    };
  } catch {
    return null;
  }
}
