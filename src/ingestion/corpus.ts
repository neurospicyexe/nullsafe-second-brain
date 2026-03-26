import fs from 'fs'
import path from 'path'
import type { IngestionConfig, IngestRecord, SourceType } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import { semanticChunk } from './chunker.js'
import type { SemanticChunk } from './chunker.js'
import { wrapChunk } from './deepseek-wrapper.js'

export interface CorpusOptions {
  intakeDir: string
  sourceType: SourceType
}

export async function withConcurrencyLimit<T>(
  items: T[],
  limit: number,
  delayMs: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += limit) {
    batches.push(items.slice(i, i + limit))
  }

  for (const batch of batches) {
    await Promise.all(batch.map(fn))
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
}

export async function processCorpus(
  options: CorpusOptions,
  config: IngestionConfig,
  store: VectorStore,
  embedder: OpenAIEmbedder
): Promise<void> {
  const files = fs.readdirSync(options.intakeDir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(options.intakeDir, f))

  console.log(`[corpus] processing ${files.length} files from ${options.intakeDir}`)

  let totalIndexed = 0
  let totalSkipped = 0

  for (const filePath of files) {
    const fileName = path.basename(filePath)
    console.log(`[corpus] chunking ${fileName}`)

    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch (err) {
      console.error(`[corpus] failed to read ${fileName}:`, err)
      continue
    }

    let chunks: SemanticChunk[]
    try {
      chunks = await semanticChunk(content, config)
    } catch (err) {
      console.error(`[corpus] chunking failed for ${fileName}:`, err)
      continue
    }

    console.log(`[corpus] ${fileName}: ${chunks.length} chunks`)

    await withConcurrencyLimit(
      chunks.map((chunk, i) => ({ chunk, i })),
      config.concurrencyLimit,
      config.concurrencyDelayMs,
      async ({ chunk, i }: { chunk: SemanticChunk; i: number }) => {
        const chunkKey = `${fileName}-${i}`
        const vaultPath = `rag/${options.sourceType}/${fileName}/${i}`

        if (store.existsByPath(vaultPath)) {
          totalSkipped++
          return
        }

        const record: IngestRecord = {
          id: i,
          source_type: options.sourceType,
          content: chunk.content,
          created_at: new Date().toISOString(),
        }

        try {
          const wrapped = await wrapChunk(record, config)
          const embedding = await embedder.embed(wrapped)

          store.insert({
            vault_path: vaultPath,
            chunk_text: wrapped,
            embedding,
            companion: null,
            content_type: options.sourceType,
            tags: [chunk.label],
          })

          totalIndexed++
        } catch (err) {
          console.error(`[corpus] failed to index ${chunkKey}:`, err)
        }
      }
    )
  }

  console.log(`[corpus] complete: ${totalIndexed} indexed, ${totalSkipped} skipped`)
}
