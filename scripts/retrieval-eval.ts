// Retrieval eval (2026-10-24). "Has search gotten better?" had no answer until now: the only
// quality signal in the repo was the hand calibration in the RECALL_FLOOR comment
// (tools/retrieval.ts), a one-off from 2026-08-10 that nobody could re-run. This script re-runs it.
//
// Seed set: scripts/retrieval-eval.queries.json, the same 9 positives / 5 negatives that set the
// floor, each with an optional `must_contain` substring the answer is known to carry. Add a line
// whenever a query you KNOW the answer to comes up; the number only means something as the set grows.
//
// Scoring, per query, through the live sb_search (same code path the companions use):
//   expect "hit"  -> PASS when recall mode returns >= 1 chunk and, if must_contain is set, some
//                    returned chunk contains it (case-insensitive). Reports top cosine + the pool
//                    that carried the match in default mode.
//   expect "miss" -> PASS when recall mode returns nothing (top cosine under RECALL_FLOOR).
//
// Cost: one OpenAI embedding per query per mode (~28 calls for the seed set). No DeepSeek calls.
//
//   npx tsx scripts/retrieval-eval.ts [queries.json] [--limit 10] [--json]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { buildRetrievalTools } from '../src/tools/retrieval.js'

interface EvalQuery { query: string; expect: 'hit' | 'miss'; must_contain?: string }
interface Chunk { text: string; cosine: number | null; pool: number; vault_path: string }

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const limitIdx = argv.indexOf('--limit')
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 10
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--limit') ?? fileURLToPath(new URL('./retrieval-eval.queries.json', import.meta.url))
  const queries = JSON.parse(readFileSync(file, 'utf8')) as EvalQuery[]

  const { store, embedder } = createServer(loadConfig())
  const { sb_search } = buildRetrievalTools(store, embedder)

  const rows: Array<Record<string, unknown>> = []
  let pass = 0
  for (const q of queries) {
    const recall = await sb_search({ query: q.query, limit, mode: 'recall' }) as { chunks: Chunk[]; degraded?: string }
    if (recall.degraded) {
      console.error(`[retrieval-eval] embedder degraded (${recall.degraded}); numbers below are lexical-only and NOT comparable`)
    }
    const topCos = recall.chunks.reduce((m, c) => Math.max(m, c.cosine ?? 0), 0)
    const needle = q.must_contain?.toLowerCase()
    const hitChunk = needle ? recall.chunks.find(c => c.text.toLowerCase().includes(needle)) : recall.chunks[0]
    let ok: boolean
    let pool: number | null = null
    if (q.expect === 'hit') {
      ok = recall.chunks.length > 0 && !!hitChunk
      // Which pool carries it in the DEFAULT shape (the one the bots call without mode)?
      const def = await sb_search({ query: q.query, limit }) as { chunks: Chunk[] }
      const inDefault = needle ? def.chunks.find(c => c.text.toLowerCase().includes(needle)) : def.chunks[0]
      pool = inDefault?.pool ?? null
    } else {
      ok = recall.chunks.length === 0
    }
    if (ok) pass++
    rows.push({ query: q.query, expect: q.expect, pass: ok, top_cosine: Math.round(topCos * 1000) / 1000, returned: recall.chunks.length, pool_in_default: pool, hit_path: hitChunk?.vault_path ?? null })
  }

  const hits = queries.filter(q => q.expect === 'hit').length
  const hitPass = rows.filter(r => r.expect === 'hit' && r.pass).length
  const missPass = rows.filter(r => r.expect === 'miss' && r.pass).length
  const summary = { date: new Date().toISOString().slice(0, 10), queries: queries.length, pass, hit_at_k: `${hitPass}/${hits}`, true_negatives: `${missPass}/${queries.length - hits}`, limit }

  if (json) {
    console.log(JSON.stringify({ summary, rows }, null, 2))
  } else {
    for (const r of rows) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${String(r.expect).padEnd(4)} cos=${String(r.top_cosine).padEnd(5)} n=${String(r.returned).padEnd(2)} pool=${r.pool_in_default ?? '-'}  ${r.query}${r.pass ? '' : `   (hit_path=${r.hit_path})`}`)
    }
    console.log(`\n${summary.date}: ${pass}/${queries.length} pass; hit@${limit} ${summary.hit_at_k}; true negatives ${summary.true_negatives}`)
  }
  store.close()
  process.exit(0)
}

main().catch(err => {
  console.error('[retrieval-eval] fatal:', err)
  process.exit(1)
})
