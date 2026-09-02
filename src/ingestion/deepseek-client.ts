// src/ingestion/deepseek-client.ts
//
// Thin OpenAI-compatible chat completions client shared by all ingestion workers.
// Vendor is env-selected (2026-09-02): DEEPSEEK_BASE_URL points the whole ingestion tier at
// DeepInfra (or any OpenAI-compatible host); unset, it falls back to the DeepSeek platform.
// This module was the last raw-platform caller in the suite after the DeepInfra cutover -- it
// drained the fallback lane to -$0.03 chewing its self-healed backlog on the delisted
// `deepseek-chat` alias.

export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

export async function callDeepSeek(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`DeepSeek API failed: ${res.status} ${text}`)
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('DeepSeek returned empty content')
  return content.trim()
}
