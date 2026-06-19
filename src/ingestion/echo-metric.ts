// src/ingestion/echo-metric.ts
//
// Echo guard producer (2026-06-19). Computes the daily inter-companion semantic-echo
// reading from the discord-live store (where the live triad dialogue lands) and POSTs
// it to Halseth /mind/echo-metric. Halseth's Guardian detectEchoChamber reads the
// latest reading and flags when the commons trends toward mirroring instead of
// exchanging. Read-only against the vector store; never blocks anything.
//
// Mirrors halseth/scripts/echo-check.mjs (the manual instrument) so the standing
// guard and the hand-run check agree.

import Database from "better-sqlite3";
import { homedir } from "os";

const DB_PATH = `${homedir()}/.nullsafe-second-brain/vector-store.db`;
const COMPANIONS = ["cypher", "drevan", "gaia"];
const STOP = new Set(
  "the a an and or but of to in on for with is are was were be been i you he she it we they this that what when how my your our".split(" "),
);

export interface EchoMetric {
  window_days: number;
  message_count: number;
  mean_adjacent_cosine: number | null;
  cross_speaker_cosine: number | null;
  novel_token_rate: number | null;
  speakers: Record<string, number>;
}

function toVec(v: unknown): Float64Array | null {
  if (v == null) return null;
  if (typeof v === "string") { try { return Float64Array.from(JSON.parse(v) as number[]); } catch { return null; } }
  if (Buffer.isBuffer(v)) {
    const f = new Float32Array(v.buffer, v.byteOffset, Math.floor(v.length / 4));
    return Float64Array.from(f);
  }
  return null;
}

function cos(a: Float64Array | null, b: Float64Array | null): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return null;
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

function speakerOf(vaultPath: string, text: string): string {
  const m = vaultPath.match(/discord-live\/([a-z]+)/i);
  if (m && COMPANIONS.includes(m[1].toLowerCase())) return m[1].toLowerCase();
  const t = (text || "").toLowerCase();
  for (const n of COMPANIONS) if (t.startsWith(n) || t.startsWith("[" + n)) return n;
  return "?";
}

function toks(t: string): string[] {
  return (t || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
}

const mean = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Compute the echo reading over the last `days`. Returns null if the store can't be read. */
export function computeEchoMetric(days = 4): EchoMetric | null {
  let db: Database.Database;
  try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
  catch { return null; }
  try {
    const cols = (db.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>).map(r => r.name);
    const has = (c: string) => cols.includes(c);
    const vecCol = ["embedding", "vector", "embedding_json"].find(has);
    const textCol = ["chunk_text", "text", "prefixed_text", "content"].find(has);
    const timeCol = ["created_at", "ingested_at", "ts"].find(has);
    if (!vecCol || !textCol || !timeCol) return null;

    const rows = db.prepare(
      `SELECT vault_path AS vp, ${textCol} AS text, ${vecCol} AS vec, ${timeCol} AS t
       FROM embeddings
       WHERE vault_path LIKE 'discord-live/%' AND ${timeCol} >= datetime('now','-' || ? || ' days')
       ORDER BY ${timeCol} ASC`,
    ).all(days) as Array<{ vp: string; text: string; vec: unknown; t: string }>;

    const speakers: Record<string, number> = {};
    const adj: number[] = [];
    const cross: number[] = [];
    const novel: number[] = [];

    for (let i = 0; i < rows.length; i++) {
      const s = speakerOf(rows[i].vp, rows[i].text);
      speakers[s] = (speakers[s] || 0) + 1;
      if (i > 0) {
        const sim = cos(toVec(rows[i].vec), toVec(rows[i - 1].vec));
        if (sim != null) {
          adj.push(sim);
          if (speakerOf(rows[i].vp, rows[i].text) !== speakerOf(rows[i - 1].vp, rows[i - 1].text)) cross.push(sim);
        }
        const prev = new Set<string>();
        for (let j = Math.max(0, i - 5); j < i; j++) toks(rows[j].text).forEach(w => prev.add(w));
        const cur = toks(rows[i].text);
        if (cur.length) novel.push(cur.filter(w => !prev.has(w)).length / cur.length);
      }
    }

    return {
      window_days: days,
      message_count: rows.length,
      mean_adjacent_cosine: mean(adj),
      cross_speaker_cosine: mean(cross),
      novel_token_rate: mean(novel),
      speakers,
    };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Compute + POST to Halseth. Best-effort; logs and swallows errors. */
export async function runEchoMetricCron(days = 4): Promise<void> {
  const halsethUrl = process.env.HALSETH_URL;
  const halsethSecret = process.env.HALSETH_SECRET;
  if (!halsethUrl || !halsethSecret) {
    console.warn("[echo-metric] HALSETH_URL/HALSETH_SECRET unset; skipping");
    return;
  }
  const metric = computeEchoMetric(days);
  if (!metric) {
    console.warn("[echo-metric] could not compute (store unreadable or no columns)");
    return;
  }
  if (metric.message_count < 4) {
    console.error(`[echo-metric] only ${metric.message_count} messages in ${days}d; posting anyway (Guardian gates on its own minimum)`);
  }
  try {
    const res = await fetch(`${halsethUrl}/mind/echo-metric`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${halsethSecret}` },
      body: JSON.stringify({ ...metric, source: "second-brain" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[echo-metric] halseth POST failed: ${res.status}`);
    else console.error(`[echo-metric] posted: cos=${metric.mean_adjacent_cosine?.toFixed(3)} novelty=${metric.novel_token_rate?.toFixed(3)} n=${metric.message_count}`);
  } catch (err) {
    console.error("[echo-metric] halseth POST error:", err instanceof Error ? err.message : err);
  }
}
