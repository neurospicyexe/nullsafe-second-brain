import type { IngestRecord } from './types.js'
import { chatComplete } from './deepseek-client.js'
import { withOwnerPronounRule } from '../pronoun-rule.js'

export function buildWrapPrompt(record: IngestRecord): string {
  return `You are annotating a chunk of relational data for semantic search.
Given the following ${record.source_type} from companion ${record.companion_id ?? 'unknown'}:

${record.content}

Metadata: date=${record.created_at}, thread=${record.thread_key ?? 'none'}

Write a 2-3 sentence contextual preamble that captures:
- Who wrote this and their emotional register
- What relational thread or topic this belongs to
- The emotional weight and significance

Preamble:`
}

export function parseWrappedOutput(raw: string, originalContent: string): string {
  const preamble = raw.trim()
  return `${preamble}\n\n${originalContent}`
}

export async function wrapChunk(
  record: IngestRecord,
  config: { deepseekApiKey: string; deepseekModel: string }
): Promise<string> {
  const prompt = buildWrapPrompt(record)

  // DeepInfra first, direct DeepSeek only as the emergency lane (deepseek-client.ts).
  const result = await chatComplete({
    // The wrap preamble names "who wrote this" and can reference Raziel directly -- carry the
    // owner pronoun rule as its own system message (2026-09-24).
    messages: [
      { role: 'system', content: withOwnerPronounRule('') },
      { role: 'user', content: prompt },
    ],
    maxTokens: 200,
    temperature: 0.3,
    caller: 'wrapChunk',
  }, config)

  if (!result.ok) {
    throw new Error(`DeepSeek API error ${result.status ?? 'network'}: ${result.text}`)
  }

  const preamble = result.content

  if (!preamble) {
    throw new Error('DeepSeek returned empty preamble')
  }

  return parseWrappedOutput(preamble, record.content)
}
