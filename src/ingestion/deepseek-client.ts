// src/ingestion/deepseek-client.ts
//
// Thin DeepSeek chat completions client shared by all ingestion workers.

export async function callDeepSeek(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
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
