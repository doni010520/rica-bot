/**
 * src/agent/rica.ts
 *
 * Agent principal da Rica — equivalente do nó "Rica" (AI Agent) do n8n.
 *
 * Usa o AI SDK da Vercel (generateText) com:
 *   - Model: gpt-4.1-mini (mesma do n8n)
 *   - Temperature: 0.5 (mesma do n8n)
 *   - Memory: Postgres Chat Memory (historyToMessages)
 *   - System prompt: buildSystemPrompt (arquivos .md)
 *   - Tools: Sprint 2+ (aqui passamos tools vazias para o core funcionar)
 *
 * Sprint 1: sem tools — só conversa com memória.
 * Sprint 2: adiciona 14 CRM tools (Zod typed).
 * Sprint 3: adiciona notificar_equipe, designar_lead.
 */

import { generateText, type CoreTool } from 'ai'
import { openai } from '@ai-sdk/openai'
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { buildSystemPrompt, type CrmContext } from './prompt.js'
import { loadChatHistory, saveChatTurn, historyToMessages } from '../memory/postgres-chat.js'

// ─── tipos ────────────────────────────────────────────────────────────────────

export type RicaInput = {
  phone: string
  displayName: string
  userMessage: string
  crm: CrmContext
  /** Tools tipadas com Zod — Sprint 2+ */
  tools?: Record<string, CoreTool>
}

export type RicaOutput = {
  text: string
  /** true se o LLM retornou vazio e foi enviada mensagem de fallback */
  usedFallback: boolean
  /** Número de steps (tool calls) executados */
  steps: number
}

// ─── agent principal ──────────────────────────────────────────────────────────

/**
 * Executa o agent da Rica para uma mensagem do usuário.
 *
 * Fluxo:
 *   1. Carrega histórico de chat do Postgres
 *   2. Monta system prompt com dados do CRM injetados
 *   3. Chama generateText com modelo, memória e tools
 *   4. Valida resposta (não vazia) — replica If pós-Edit Fields2
 *   5. Salva turno na memória
 *   6. Retorna texto para envio
 *
 * @returns RicaOutput com texto gerado (ou fallback se vazio)
 */
export async function runRica(input: RicaInput, pool: Pool): Promise<RicaOutput> {
  const { phone, displayName, userMessage, crm, tools = {} } = input

  const log = logger.child({ phone: phone.slice(-4), context: 'rica-agent' })
  log.info({ msgLen: userMessage.length }, 'Executando agent')

  // 1. Carrega histórico
  const history = await loadChatHistory(pool, phone)
  const previousMessages = historyToMessages(history)

  // 2. Monta system prompt
  const systemPrompt = buildSystemPrompt(crm, phone, displayName)

  // 3. Chama o LLM
  const hasTools = Object.keys(tools).length > 0

  let result: Awaited<ReturnType<typeof generateText>>

  try {
    result = await generateText({
      model: openai(env.OPENAI_MODEL),
      temperature: env.OPENAI_TEMPERATURE,
      system: systemPrompt,
      messages: [
        ...previousMessages,
        { role: 'user', content: userMessage },
      ],
      // Tools habilitadas apenas quando fornecidas (Sprint 2+)
      ...(hasTools ? { tools, maxSteps: 10 } : {}),
    })
  } catch (err) {
    log.error({ err }, 'Erro no generateText — retornando fallback')
    return { text: '', usedFallback: true, steps: 0 }
  }

  const rawText = result.text?.trim() ?? ''
  const stepCount = result.steps?.length ?? 0

  // 4. Valida resposta vazia (replica: If pós-Edit Fields2 do n8n)
  if (!rawText) {
    log.warn({ stepCount }, 'Agent retornou resposta vazia')
    return { text: '', usedFallback: true, steps: stepCount }
  }

  log.info({ textLen: rawText.length, stepCount }, 'Agent respondeu')

  // 5. Salva turno na memória
  await saveChatTurn(pool, phone, userMessage, rawText)

  return { text: rawText, usedFallback: false, steps: stepCount }
}
