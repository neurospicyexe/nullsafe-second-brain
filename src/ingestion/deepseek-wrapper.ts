import type { IngestRecord } from './types.js'

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface DeepSeekResponse {
  choices: Array<{
    message: { role: string; content: string }
  }>
}

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

  const body = {
    model: config.deepseekModel,
    messages: [
      {
        role: 'user' as const,
        content: prompt,
      },
    ] satisfies DeepSeekMessage[],
    max_tokens: 200,
    temperature: 0.3,
  }

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`DeepSeek API error ${response.status}: ${errorText}`)
  }

  const data = (await response.json()) as DeepSeekResponse
  const preamble = data.choices[0]?.message?.content ?? ''

  if (!preamble) {
    throw new Error('DeepSeek returned empty preamble')
  }

  return parseWrappedOutput(preamble, record.content)
}
