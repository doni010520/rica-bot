/**
 * src/followup/worker.ts
 *
 * Worker de follow-up — replica o workflow "Rica - Follow-up Automatico" do n8n.
 *
 * Cron: a cada hora entre 9h-18h, seg-sex (America/Sao_Paulo)
 *
 * Fluxo por execução:
 *   1. GET /deals/followup-candidates
 *   2. Para cada candidato:
 *      a. Carrega memória da conversa
 *      b. Sub-agente gera mensagem contextual
 *      c. Envia via uazapi
 *      d. PATCH /deals/:id/followup (incrementa contador)
 *   3. POST /deals/close-inactive (fecha após N tentativas + dias)
 */

import cron from 'node-cron'
import type { Pool } from 'pg'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { env } from '../lib/env.js'
import { logger, followupLogger } from '../observability/logger.js'
import { loadChatHistory, historyToMessages } from '../memory/postgres-chat.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { crmRequest } from '../lib/crm-client.js'
import { isBusinessHour } from '../lib/timezone.js'

// ─── tipos ────────────────────────────────────────────────────────────────────

type FollowupCandidate = {
  id: string
  contact_name?: string | undefined
  contact_phone?: string | undefined
  followup_count?: number | undefined
  last_followup_at?: string | undefined
  last_client_message_at?: string | undefined
  title?: string | undefined
}

// ─── worker principal ─────────────────────────────────────────────────────────

let _cronTask: ReturnType<typeof cron.schedule> | null = null

/**
 * Inicia o worker de follow-up.
 * @param pool - Pool Postgres para carregar memória
 */
export function startFollowupWorker(pool: Pool): void {
  if (_cronTask) {
    logger.warn('Follow-up worker já está rodando')
    return
  }

  // Cron: minuto 0 de cada hora entre 9-18h, seg-sex
  _cronTask = cron.schedule(
    env.FOLLOWUP_CRON,
    async () => {
      // Proteção extra: verifica horário de negócio (BRT)
      if (!isBusinessHour()) {
        logger.debug('follow-up: fora do horário — skip')
        return
      }
      await runFollowupCycle(pool)
    },
    { timezone: env.FOLLOWUP_TIMEZONE, scheduled: true },
  )

  logger.info({ cron: env.FOLLOWUP_CRON, timezone: env.FOLLOWUP_TIMEZONE }, '📅 Follow-up worker iniciado')
}

export function stopFollowupWorker(): void {
  _cronTask?.stop()
  _cronTask = null
}

// ─── ciclo de follow-up ───────────────────────────────────────────────────────

async function runFollowupCycle(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'followup-cycle' })
  log.info('Iniciando ciclo de follow-up')

  // 1. Busca candidatos
  let candidates: FollowupCandidate[] = []
  try {
    const raw = await crmRequest<unknown>('/api/crm/deals/followup-candidates')
    candidates = Array.isArray(raw) ? (raw as FollowupCandidate[]) : []
    log.info({ count: candidates.length }, 'Candidatos encontrados')
  } catch (err) {
    log.error({ err }, 'Falha ao buscar candidatos — abortando ciclo')
    return
  }

  // 2. Processa cada candidato
  let sent = 0
  let errors = 0

  for (const candidate of candidates) {
    try {
      await processFollowupCandidate(candidate, pool)
      sent++
    } catch (err) {
      errors++
      log.error({ err, dealId: candidate.id }, 'Erro ao processar candidato')
    }
    // Pequena pausa entre envios para não sobrecarregar uazapi
    await new Promise((r) => setTimeout(r, 500))
  }

  // 3. Fecha deals inativos
  try {
    await crmRequest('/api/crm/deals/close-inactive', {
      method: 'POST',
      params: { days: String(env.FOLLOWUP_CLOSE_AFTER_DAYS) },
      operationName: 'close_inactive',
    })
  } catch (err) {
    log.warn({ err }, 'Falha ao fechar deals inativos')
  }

  log.info({ sent, errors, total: candidates.length }, 'Ciclo de follow-up concluído')
}

// ─── processamento individual ─────────────────────────────────────────────────

async function processFollowupCandidate(
  candidate: FollowupCandidate,
  pool: Pool,
): Promise<void> {
  const phone = candidate.contact_phone ?? ''
  const log = followupLogger(candidate.id)

  if (!phone) {
    log.warn('Candidato sem telefone — skip')
    return
  }

  const followupNumber = (candidate.followup_count ?? 0) + 1
  log.info({ phone: phone.slice(-4), followupNumber }, 'Processando follow-up')

  // Carrega histórico da conversa
  const history = await loadChatHistory(pool, phone)
  const messages = historyToMessages(history)

  // Gera mensagem contextual via sub-agente
  const followupText = await generateFollowupMessage({
    candidateName: candidate.contact_name ?? '',
    followupNumber,
    history: messages,
    dealTitle: candidate.title ?? '',
  })

  if (!followupText.trim()) {
    log.warn('Sub-agente retornou mensagem vazia — skip')
    return
  }

  // Envia mensagem
  await sendWhatsApp(phone, followupText)

  // Incrementa contador no CRM
  await crmRequest(`/api/crm/deals/${encodeURIComponent(candidate.id)}/followup`, {
    method: 'PATCH',
    body: { followup_text: followupText },
    operationName: 'increment_followup',
  })

  log.info({ phone: phone.slice(-4), followupNumber }, 'Follow-up enviado')
}

// ─── sub-agente de follow-up ──────────────────────────────────────────────────

const FOLLOWUP_SYSTEM_PROMPT = `Você é a Rica Follow-up, uma versão especializada da Rica focada em RETOMAR conversas de leads que pararam de responder.

CONTEXTO:
- Você recebe dados de um lead que já conversou com a Rica principal, mas não respondeu mais.
- Você tem acesso ao histórico completo da conversa anterior (via memória).

SEU OBJETIVO:
Gerar UMA única mensagem curta, humana e contextual para retomar a conversa DE ONDE ELA PAROU.

REGRAS FUNDAMENTAIS:
1. ANÁLISE ANTES DE ESCREVER: leia a memória, identifique o último tópico aberto.
2. NATURALIDADE: escreva como humano, NUNCA mencione "follow-up", "tentativa", "retomada".
3. ADAPTAÇÃO AO NÚMERO:
   - followup 1: leve, curioso ("Oi! Ficou alguma dúvida? 😊")
   - followup 2: específico, recupera tópico ("Oi! Sobre aquele produto que conversamos...")
   - followup 3: apresenta gatilho novo ("Oi! Abriu uma vaga nova. Se ainda tiver interesse, me avisa!")
4. FORMATO: curto (2-4 linhas), termina com pergunta/gancho, tom amigável.
5. SAÍDA: retorne APENAS o texto da mensagem. Sem prefácios, aspas ou explicações.
IMPORTANTE: NUNCA invente informações. Se não souber o nome, use "oi" sem nome.`

async function generateFollowupMessage(params: {
  candidateName: string
  followupNumber: number
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  dealTitle: string
}): Promise<string> {
  const { candidateName, followupNumber, history, dealTitle } = params

  const context = [
    `Nome do lead: ${candidateName || 'não informado'}`,
    `Número do follow-up: ${followupNumber}`,
    `Título do deal: ${dealTitle}`,
    `Histórico: ${history.length} mensagens`,
  ].join('\n')

  try {
    const result = await generateText({
      model: openai(env.OPENAI_MODEL),
      temperature: 0.7, // levemente mais criativo que o agent principal
      system: FOLLOWUP_SYSTEM_PROMPT,
      messages: [
        ...history.slice(-10), // últimas 10 mensagens para contexto
        {
          role: 'user',
          content: `Contexto atual:\n${context}\n\nGere a mensagem de follow-up:`,
        },
      ],
    })
    return result.text?.trim() ?? ''
  } catch (err) {
    logger.error({ err }, 'Falha no sub-agente de follow-up')
    return ''
  }
}
