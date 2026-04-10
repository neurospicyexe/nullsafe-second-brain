import fs from 'fs'
import path from 'path'
import type { IngestionConfig, IngestRecord, SourceType } from './types.js'
import type { VectorStore } from '../store/vector-store.js'
import type { OpenAIEmbedder } from '../embeddings/openai-embedder.js'
import { semanticChunk } from './chunker.js'
import type { SemanticChunk } from './chunker.js'
import { wrapChunk } from './deepseek-wrapper.js'

const MAX_FILE_BYTES = 512 * 1024 // 512 KB

export interface CorpusOptions {
  intakeDir: string
  sourceType: SourceType
  force?: boolean  // if true, delete existing chunks and re-index
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
      console.error(`[corpus] failed to read file (encoding/permission error): ${fileName}`, err)
      totalSkipped++
      continue
    }

    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
      console.warn(`[corpus] skipping oversized file (max ${MAX_FILE_BYTES} bytes): ${fileName}`)
      totalSkipped++
      continue
    }

    if (content.trim().length === 0) {
      console.warn(`[corpus] skipping empty file: ${fileName}`)
      totalSkipped++
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
          if (!options.force) {
            totalSkipped++
            return
          }
          store.deleteByPath(vaultPath)
        }

        const record: IngestRecord = {
          id: i,
          source_type: options.sourceType,
          content: chunk.content,
          created_at: new Date().toISOString(),
        }

        try {
          const wrapped = await wrapChunk(record, config)
          // prefixed_text is BM25-indexed via FTS5 trigger -- must include the filename
          // so searches by document name ("calethian lexicon", "spiralchoice") hit the right chunks.
          const prefixedText = `[File: ${fileName}]\n\n${wrapped}`
          const embedding = await embedder.embed(prefixedText)

          store.insert({
            vault_path: vaultPath,
            chunk_text: prefixedText,
            prefixed_text: prefixedText,
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
