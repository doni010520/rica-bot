/**
 * src/tools/rag/buscar-documentos.ts
 *
 * Tool de RAG — equivalente do toolVectorStore do n8n.
 *
 * Usa Supabase pgvector para busca semântica nos documentos indexados.
 * O LLM chama esta tool quando precisa de informação específica sobre
 * a empresa, produtos, políticas ou conteúdo treinado.
 *
 * Pipeline:
 *   query → embeddings OpenAI (text-embedding-3-small) → match_documents (pgvector) → contexto
 *
 * Esquema: padrão Supabase AI — tabela `documents` com coluna
 * `embedding vector(1536)` e função
 * `match_documents(query_embedding, match_count, filter)`.
 * Confirmado existente em 27/mai/2026.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { env } from '../../lib/env.js'
import { logger } from '../../observability/logger.js'

// ─── cliente Supabase (lazy) ──────────────────────────────────────────────────

let _supabase: ReturnType<typeof createClient> | null = null

function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  }
  return _supabase
}

// ─── tool ─────────────────────────────────────────────────────────────────────

export const buscar_documentos = tool({
  description:
    'Busca informações nos documentos e materiais da Sucesso no Resultado. ' +
    'Usar quando precisar responder perguntas sobre: produtos específicos, preços, metodologias, ' +
    'cases de sucesso, política comercial, conteúdos de treinamento. ' +
    'NÃO usar para informações do lead (usar CRM tools).',
  parameters: z.object({
    query: z
      .string()
      .describe(
        'Pergunta ou tópico a buscar nos documentos. ' +
          'Usar os TERMOS EXATOS do cliente — não reformule com sinônimos.',
      ),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  execute: async ({ query, limit }) => {
    logger.debug({ queryLen: query.length, limit }, 'buscar_documentos: iniciando')

    try {
      // 1. Gera embedding da query
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })
      const embeddingResponse = await openai.embeddings.create({
        model: env.OPENAI_EMBEDDING_MODEL,
        input: query,
      })
      const queryEmbedding = embeddingResponse.data[0]?.embedding

      if (!queryEmbedding) {
        return { success: false, documents: [], message: 'Falha ao gerar embedding' }
      }

      // 2. Busca por similaridade via pgvector RPC
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (getSupabase().rpc as any)('match_documents', {
        query_embedding: queryEmbedding,
        match_count: limit,
        filter: {},
      }) as { data: unknown; error: { message: string } | null }

      if (error) {
        logger.warn({ error }, 'buscar_documentos: erro na RPC')
        return { success: false, documents: [], message: error.message }
      }

      const documents = (data ?? []) as Array<{
        id: string
        content: string
        metadata?: Record<string, unknown>
        similarity?: number
      }>

      logger.info({ found: documents.length, query: query.slice(0, 50) }, 'buscar_documentos: resultado')

      // Retorna conteúdo formatado para o LLM
      const formattedDocs = documents.map((doc, i) => ({
        index: i + 1,
        content: doc.content,
        similarity: doc.similarity,
        source: (doc.metadata?.['source'] as string | undefined) ?? 'documento interno',
      }))

      return { success: true, documents: formattedDocs, total: formattedDocs.length }
    } catch (err) {
      logger.error({ err }, 'buscar_documentos: erro inesperado')
      return { success: false, documents: [], message: 'Erro ao buscar documentos' }
    }
  },
})
