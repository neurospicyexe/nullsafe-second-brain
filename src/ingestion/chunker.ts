import type { IngestionConfig } from './types.js'

export interface SemanticChunk {
  label: string
  content: string
}

const CHUNK_PROMPT_TEMPLATE = `Split this conversation at topic shifts, emotional pivots, or facet changes. Return ONLY a JSON array, no other text.

Each element: { "label": "<brief label>", "content": "<the chunk text>" }

Conversation:
{CONTENT}

JSON array:`

export async function semanticChunk(
  content: string,
  config: Pick<IngestionConfig, 'deepseekApiKey' | 'deepseekModel'>
): Promise<SemanticChunk[]> {
  const MAX_CHARS = 80_000

  if (content.length > MAX_CHARS) {
    const segments = splitIntoSegments(content, MAX_CHARS)
    const results: SemanticChunk[] = []
    for (const segment of segments) {
      const chunks = await chunkSegment(segment, config)
      results.push(...chunks)
    }
    return results
  }

  return chunkSegment(content, config)
}

export function splitIntoSegments(content: string, maxChars: number): string[] {
  const paragraphs = content.split(/\n\n+/)
  const segments: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      segments.push(current.trim())
      current = para
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

async function chunkSegment(
  content: string,
  config: Pick<IngestionConfig, 'deepseekApiKey' | 'deepseekModel'>
): Promise<SemanticChunk[]> {
  const prompt = CHUNK_PROMPT_TEMPLATE.replace('{CONTENT}', content)

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.2,
    }),
  })

  if (!response.ok) {
    throw new Error(`DeepSeek chunking failed: ${response.status}`)
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> }
  const raw = data.choices[0]?.message?.content ?? ''

  // Extract JSON array -- model may wrap in markdown or add preamble text
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`DeepSeek chunk response missing JSON array: ${raw.slice(0, 200)}`)
  }
  const jsonStr = raw.slice(start, end + 1)

  try {
    return JSON.parse(jsonStr) as SemanticChunk[]
  } catch {
    throw new Error(`Failed to parse DeepSeek chunk response: ${jsonStr.slice(0, 200)}`)
  }
}
