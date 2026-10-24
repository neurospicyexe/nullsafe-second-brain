// src/ingestion/deepseek-client.ts
//
// The ONE OpenAI-compatible chat client for every ingestion worker (wrap, chunk, gap-fill,
// pattern synthesis, persona feeder, inbox classify). Every DeepSeek-model call in Second Brain
// goes through `chatComplete()` below; nothing else in src/ may fetch a completions URL.
//
// Vendor order (2026-09-26, Raziel's rule): DeepInfra FIRST -- same DeepSeek-V4-Flash weights --
// and the direct DeepSeek platform only as an EMERGENCY fallback (~$10 kept there, just enough
// to still get a message out and know something is wrong). Every drop onto direct DeepSeek logs
// one line, `[inference] FELL BACK to direct DeepSeek (DeepInfra failed: <why>)`, so a drain is
// visible in journalctl with a single grep.
//
// Env (read at CALL time, so tests and a live .env edit both take effect without a rebuild):
//   DEEPINFRA_API_KEY   DeepInfra key -> primary lane
//   DEEPSEEK_API_KEY    direct DeepSeek platform key -> emergency lane (config.deepseekApiKey)
//   DEEPINFRA_MODEL     optional DeepInfra model id override
//   DEEPSEEK_BASE_URL / DEEPSEEK_MODEL  LEGACY (2026-09-02). Before this file learned two vendors,
//     the VPS pointed the single lane at DeepInfra by setting DEEPSEEK_BASE_URL to api.deepinfra.com
//     -- which means DEEPSEEK_API_KEY holds a DeepInfra key there. That alias is honored: with no
//     DEEPINFRA_API_KEY and a DeepInfra DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY is used AS the DeepInfra
//     key and the emergency lane stays unarmed (warned once). It is never sent to api.deepseek.com.

import { withOwnerPronounRule } from '../pronoun-rule.js'
import { fetchHouseholdFacts, householdGroundingBlock, type HouseholdGroundingConfig } from './household-grounding.js'

export const DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai'
export const DEEPSEEK_DIRECT_BASE_URL = 'https://api.deepseek.com'
/** DeepInfra's id for the same weights as api.deepseek.com's `deepseek-v4-flash`. */
export const DEEPINFRA_FLASH_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'
/** The direct platform's live flash id (`deepseek-chat` is DELISTED -- it answers with reasoning off). */
export const DEEPSEEK_DIRECT_MODEL = 'deepseek-v4-flash'
/** Reasoning tokens are billed against max_tokens and emitted before content on every DeepSeek
 * V4 model, on both vendors -- a ceiling below the burn returns "" with finish_reason=length.
 * Same number as halseth/src/synthesis/deepseek.ts and the bots' adapters. */
export const REASONING_HEADROOM = 3000
export const FELL_BACK_TAG = '[inference] FELL BACK to direct DeepSeek'

export interface Vendor {
  baseUrl: string
  apiKey: string
  model: string
  label: 'DeepInfra' | 'DeepSeek'
}

export interface VendorConfig {
  deepseekApiKey?: string
  deepseekModel?: string
}

const isDeepInfraUrl = (u: string | undefined): boolean => !!u && /deepinfra\.com/i.test(u)
const clean = (v: string | undefined): string | undefined => v?.trim().replace(/^=+/, '') || undefined

// Configuration warnings describe a condition that does not change between calls -- say it once
// per process, not on every ingestion record.
const warned = new Set<string>()
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(msg)
}
/** Test hook: re-arm the once-per-process configuration warnings. */
export function resetVendorWarnings(): void { warned.clear() }

/** Resolve the vendor chain, primary first. Pure apart from the once-per-process warnings. */
export function resolveVendors(config: VendorConfig, env: NodeJS.ProcessEnv = process.env): Vendor[] {
  const deepinfraKey = clean(env.DEEPINFRA_API_KEY)
  const deepseekKey = clean(config.deepseekApiKey)
  const legacyBase = clean(env.DEEPSEEK_BASE_URL)?.replace(/\/+$/, '')
  const legacyIsDeepInfra = isDeepInfraUrl(legacyBase)
  const configured = config.deepseekModel?.trim()
  // A slash-shaped id (deepseek-ai/...) is a DeepInfra id; a bare one is a platform id.
  const deepinfraModel = clean(env.DEEPINFRA_MODEL)
    ?? (configured && configured.includes('/') ? configured : DEEPINFRA_FLASH_MODEL)
  const deepseekModel = configured && !configured.includes('/') && configured !== 'deepseek-chat'
    ? configured
    : DEEPSEEK_DIRECT_MODEL

  const chain: Vendor[] = []
  if (deepinfraKey) {
    chain.push({ baseUrl: DEEPINFRA_BASE_URL, apiKey: deepinfraKey, model: deepinfraModel, label: 'DeepInfra' })
    if (deepseekKey && legacyIsDeepInfra) {
      warnOnce('legacy-base-with-deepinfra',
        '[inference] DEEPSEEK_BASE_URL still points at DeepInfra, so DEEPSEEK_API_KEY may be a DeepInfra key -- ' +
        'emergency DeepSeek fallback NOT armed. Unset DEEPSEEK_BASE_URL and put the DeepSeek platform key in DEEPSEEK_API_KEY.')
    } else if (deepseekKey && deepseekKey !== deepinfraKey) {
      chain.push({ baseUrl: legacyBase ?? DEEPSEEK_DIRECT_BASE_URL, apiKey: deepseekKey, model: deepseekModel, label: 'DeepSeek' })
    }
    return chain
  }
  if (deepseekKey && legacyIsDeepInfra) {
    warnOnce('legacy-alias',
      '[inference] DEEPINFRA_API_KEY absent; DEEPSEEK_BASE_URL points at DeepInfra, so DEEPSEEK_API_KEY is used AS the ' +
      'DeepInfra key. No emergency DeepSeek fallback. Fix: DEEPINFRA_API_KEY=<that key>, DEEPSEEK_API_KEY=<platform key>, ' +
      'remove DEEPSEEK_BASE_URL and DEEPSEEK_MODEL.')
    chain.push({ baseUrl: legacyBase!, apiKey: deepseekKey, model: deepinfraModel, label: 'DeepInfra' })
    return chain
  }
  if (deepseekKey) {
    warnOnce('deepseek-only',
      '[inference] DEEPINFRA_API_KEY absent -- ingestion is running on direct DeepSeek ONLY (the emergency lane). ' +
      'Add DEEPINFRA_API_KEY to .env.')
    chain.push({ baseUrl: legacyBase ?? DEEPSEEK_DIRECT_BASE_URL, apiKey: deepseekKey, model: deepseekModel, label: 'DeepSeek' })
  }
  return chain
}

/** A status the SAME payload might survive on another vendor (auth flap, empty balance, rate
 * limit, server error). A 400 is deterministic -- identical weights would fail it again on
 * DeepSeek and spend the emergency balance for nothing -- so it does not fail over. */
export function vendorFailover(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500
}

export interface ChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** CONTENT ceiling; reasoning headroom is added on top for DeepSeek models. */
  maxTokens: number
  temperature: number
  timeoutMs?: number
  /** Log tag for the FELL BACK line. */
  caller: string
}

export type ChatResult =
  | { ok: true; content: string; finishReason: string; vendor: Vendor['label'] }
  | { ok: false; status: number | null; text: string }

// ── Token accounting (2026-10-24) ───────────────────────────────────────────────────────────────
//
// Until today this client logged nothing on a 2xx, so Second Brain's share of the DeepInfra bill
// was invisible: the 6h corpus cron burned ~8M in + 4M out a day for five weeks (09-03 to 10-10)
// before anyone could see which caller it was. Every 2xx now prints ONE line, the same shape the
// Discord bots print (nullsafe-discord/packages/shared/src/inference.ts), so one awk over
// journalctl + pm2 logs sums the whole VPS:
//
//   [inference:usage] provider=DeepInfra model=<id> caller=<label> in=N out=N cached=N reasoning=N cost=<usd|->
//
// in = prompt_tokens (INCLUDES cached), out = completion_tokens (INCLUDES reasoning), cached =
// the cached subset of `in` (OpenAI `prompt_tokens_details.cached_tokens`, or DeepSeek's
// `prompt_cache_hit_tokens`), cost = the vendor's own `usage.estimated_cost` when it sends one.
// A 2xx with no `usage` object prints `usage=absent`, so line count still equals call count.
// NEVER any prompt or completion text: counts and ids only.

export const USAGE_TAG = '[inference:usage]'

export interface ApiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number } | null
  prompt_cache_hit_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number } | null
  estimated_cost?: number
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)

/** Pure formatter for the usage line (tested directly). */
export function formatUsageLine(provider: string, model: string, caller: string, usage: ApiUsage | null | undefined): string {
  const head = `${USAGE_TAG} provider=${provider} model=${model} caller=${caller || '-'}`
  if (!usage || typeof usage !== 'object') return `${head} usage=absent`
  const cached = count(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens)
  const reasoning = count(usage.completion_tokens_details?.reasoning_tokens)
  const cost = typeof usage.estimated_cost === 'number' && Number.isFinite(usage.estimated_cost) ? String(usage.estimated_cost) : '-'
  return `${head} in=${count(usage.prompt_tokens)} out=${count(usage.completion_tokens)} cached=${cached} reasoning=${reasoning} cost=${cost}`
}

/** Wire max_tokens for a content ceiling on this model. */
export function wireMaxTokens(contentTokens: number, model: string): number {
  return /deepseek/i.test(model) ? contentTokens + REASONING_HEADROOM : contentTokens
}

/**
 * Run the request down the vendor chain. Returns the first vendor's answer (content may be ""
 * -- an empty 200 is NOT failed over, since the same weights starve the same way; callers keep
 * their own empty-content handling). Returns `ok: false` with the LAST vendor's status/text when
 * every vendor failed, or `status: null` when no key is configured / the network failed.
 */
export async function chatComplete(req: ChatRequest, config: VendorConfig, env: NodeJS.ProcessEnv = process.env): Promise<ChatResult> {
  const chain = resolveVendors(config, env)
  if (chain.length === 0) {
    return { ok: false, status: null, text: 'no inference key set (DEEPINFRA_API_KEY / DEEPSEEK_API_KEY)' }
  }
  let prior: string | null = null
  let last: { status: number | null; text: string } = { status: null, text: '' }

  for (const vendor of chain) {
    if (prior !== null && vendor.label === 'DeepSeek') {
      console.warn(`${FELL_BACK_TAG} (DeepInfra failed: ${prior}) caller=${req.caller}`)
    }
    let res: Response
    try {
      res = await fetch(`${vendor.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vendor.apiKey}` },
        body: JSON.stringify({
          model: vendor.model,
          messages: req.messages,
          max_tokens: wireMaxTokens(req.maxTokens, vendor.model),
          temperature: req.temperature,
        }),
        ...(req.timeoutMs ? { signal: AbortSignal.timeout(req.timeoutMs) } : {}),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[inference] ${vendor.label} unreachable (${msg.slice(0, 120)}) caller=${req.caller}`)
      prior = `network: ${msg.slice(0, 80)}`
      last = { status: null, text: msg }
      continue
    }
    if (!res.ok) {
      const text = await res.text?.().catch(() => '') ?? ''
      console.warn(`[inference] ${vendor.label} HTTP ${res.status} (${text.slice(0, 120)}) caller=${req.caller}`)
      last = { status: res.status, text }
      if (!vendorFailover(res.status)) return { ok: false, ...last }
      prior = `HTTP ${res.status}`
      continue
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      usage?: ApiUsage | null
    }
    console.log(formatUsageLine(vendor.label, vendor.model, req.caller, data.usage))
    const choice = data.choices?.[0]
    return { ok: true, content: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? '', vendor: vendor.label }
  }
  return { ok: false, ...last }
}

/**
 * Single-prompt helper used by pattern synthesis, persona feeder and the inbox classifier.
 *
 * `grounding` (2026-10-11): pass Halseth's url/secret from any caller that WRITES PROSE about
 * Raziel's household (pattern synthesis, signal audit, persona feeder) and the household rule +
 * canonical animals record ride in the system message, exactly as wrapChunk's do. Omit it for pure
 * classifiers (the inbox filer returns a folder decision, not prose). Fails open: no facts -> the
 * rule alone.
 *
 * `caller` (2026-10-24) is the label on the usage line. Pass the worker's name (persona-feeder,
 * inbox-classify, ...); the bare default only says "some callDeepSeek user", which is what made
 * this lane unattributable before.
 */
export async function callDeepSeek(
  apiKey: string,
  model: string,
  prompt: string,
  grounding?: HouseholdGroundingConfig,
  caller = 'callDeepSeek',
): Promise<string> {
  const household = grounding ? householdGroundingBlock(await fetchHouseholdFacts(grounding)) : ''
  const result = await chatComplete({
    // This is the shared ingestion chokepoint -- callers pass only a user prompt, so the owner
    // pronoun rule rides as its own system message rather than being spliced into their prompt
    // text (2026-09-24; Raziel called "she" in synthesized session prose).
    messages: [
      { role: 'system', content: withOwnerPronounRule(household) },
      { role: 'user', content: prompt },
    ],
    maxTokens: 800,
    temperature: 0.4,
    timeoutMs: 30_000,
    caller,
  }, { deepseekApiKey: apiKey, deepseekModel: model })
  if (!result.ok) throw new Error(`DeepSeek API failed: ${result.status ?? 'network'} ${result.text}`)
  if (!result.content) throw new Error('DeepSeek returned empty content')
  return result.content.trim()
}
