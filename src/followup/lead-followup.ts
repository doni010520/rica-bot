/**
 * src/followup/lead-followup.ts
 *
 * Follow-up INTELIGENTE de leads — agendador próprio do rica-bot (não depende
 * da API do CRM). Substitui o worker por cron (followup/worker.ts, que dependia
 * de /deals/followup-candidates).
 *
 * Modelo:
 *   - Toda vez que a Rica responde um lead, agenda o toque 1 (scheduleLeadFollowup).
 *   - Se o lead NÃO responder, o toque dispara: a LLM gera uma mensagem com base
 *     na última mensagem do cliente + histórico, e agenda o próximo toque.
 *   - Qualquer mensagem do lead CANCELA os toques pendentes (cancelLeadFollowup),
 *     e a próxima resposta da Rica reinicia a régua no toque 1.
 *
 * Cadência (business hours, configurável via LEAD_FOLLOWUP_DELAYS_HOURS):
 *   toque 1 = +2h · toque 2 = +24h · toque 3 = +72h · depois para.
 *
 * "Só leads novos daqui pra frente": como só agenda para quem interage a partir
 * de agora, o backlog parado nunca entra — sem varredura, sem disparo em massa.
 *
 * Dedup: jobId = lead-fu-{phone} (upsert — reagendar cancela o anterior).
 */

import { Queue, Worker, type Job } from 'bullmq'
import type { Pool } from 'pg'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { env } from '../lib/env.js'
import { logger, followupLogger } from '../observability/logger.js'
import { loadChatHistory, historyToMessages } from '../memory/postgres-chat.js'
import { checkLidiaStatus } from '../lidia/status.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { calculateBusinessHourDelayMs } from './executive-followup.js'

// ─── config ──────────────────────────────────────────────────────────────────

const QUEUE_NAME = 'rica-lead-followup'

/** Delays (horas) por toque. Ex: [2, 24, 72] = +2h, depois +24h, depois +72h. */
const TOUCH_DELAYS_H = env.LEAD_FOLLOWUP_DELAYS_HOURS
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

/** Nº máximo de toques = tamanho da régua. */
const MAX_TOUCHES = TOUCH_DELAYS_H.length

export type LeadFollowupData = {
  phone: string       // com 55 (formato uazapi/normalizado)
  attempt: number     // 1-based
}

// ─── infra BullMQ ────────────────────────────────────────────────────────────

let _queue: Queue | null = null
let _worker: Worker | null = null

function getRedisOpts() {
  const url = new URL(env.REDIS_URL)
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
    maxRetriesPerRequest: null as null,
  }
}

function getQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: getRedisOpts(),
      defaultJobOptions: { removeOnComplete: 200, removeOnFail: 50 },
    })
  }
  return _queue
}

function jobIdFor(phone: string): string {
  return `lead-fu-${phone.replace(/\D/g, '')}`
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Agenda (ou reagenda) o próximo toque de follow-up para um lead.
 * Chamado pela Rica após responder um lead (attempt=1) e pelo próprio worker
 * após cada toque (attempt+1). Upsert: cancela o toque pendente e agenda o novo.
 */
export async function scheduleLeadFollowup(phone: string, attempt = 1): Promise<void> {
  if (!env.LEAD_FOLLOWUP_ENABLED) return
  if (attempt < 1 || attempt > MAX_TOUCHES) return

  const hours = TOUCH_DELAYS_H[attempt - 1]
  if (hours === undefined) return

  const queue = getQueue()
  const jobId = jobIdFor(phone)
  const delayMs = calculateBusinessHourDelayMs(hours)

  await queue.remove(jobId).catch(() => null)
  await queue.add('touch', { phone, attempt } satisfies LeadFollowupData, { jobId, delay: delayMs })

  logger.child({ context: 'lead-followup' }).info(
    { phone: phone.slice(-4), attempt, delayH: (delayMs / 3_600_000).toFixed(1) },
    `📨 Follow-up de lead agendado (toque ${attempt}/${MAX_TOUCHES})`,
  )
}

/**
 * Cancela qualquer toque pendente para o lead. Chamado quando o lead manda
 * mensagem (ele está ativo — não faz sentido cobrar).
 */
export async function cancelLeadFollowup(phone: string): Promise<void> {
  if (!_queue && !env.LEAD_FOLLOWUP_ENABLED) return
  try {
    await getQueue().remove(jobIdFor(phone))
  } catch {
    /* job pode não existir — ok */
  }
}

/** Inicia o worker que dispara os toques. Chamado no boot (src/index.ts). */
export function startLeadFollowupWorker(pool: Pool): Worker | null {
  if (_worker) return _worker
  if (!env.LEAD_FOLLOWUP_ENABLED) {
    logger.info('Follow-up de leads (agendador rica-bot) DESLIGADO (LEAD_FOLLOWUP_ENABLED=false)')
    return null
  }

  _worker = new Worker(
    QUEUE_NAME,
    async (job: Job<LeadFollowupData>) => {
      await processLeadFollowup(job.data, pool)
    },
    { connection: getRedisOpts(), concurrency: 5 },
  )

  _worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Lead followup job falhou')
  })

  logger.info(
    { touches: MAX_TOUCHES, delaysH: TOUCH_DELAYS_H.join(',') },
    '📨 Lead followup worker (agendador rica-bot) iniciado',
  )
  return _worker
}

export async function closeLeadFollowup(): Promise<void> {
  await _worker?.close()
  await _queue?.close()
  _worker = null
  _queue = null
}

// ─── processamento do toque ──────────────────────────────────────────────────

async function processLeadFollowup(data: LeadFollowupData, pool: Pool): Promise<void> {
  const { phone, attempt } = data
  const log = followupLogger(phone.slice(-4))

  // 1. Takeover: se um humano assumiu (Lidia OFF), não cobra.
  try {
    const lidia = await checkLidiaStatus(pool, phone)
    if (lidia.exists && lidia.lidia === 'OFF') {
      log.info('lead-followup: Lidia OFF (humano assumiu) — parando régua')
      return
    }
  } catch {
    /* fail-open: segue */
  }

  // 2. Histórico da conversa.
  const history = await loadChatHistory(pool, phone, env.CHAT_MEMORY_WINDOW)
  if (history.length === 0) {
    log.info('lead-followup: sem histórico — skip')
    return
  }

  // 3. Se a última mensagem é do CLIENTE, ele falou por último (respondeu, ou a
  //    Rica ainda deve responder). Em qualquer caso não é hora de cobrar.
  const last = history[history.length - 1]
  if (last?.role === 'human') {
    log.info('lead-followup: cliente falou por último — skip (será reagendado após resposta)')
    return
  }

  // 4. Gera a mensagem do toque com a LLM (baseada na última msg + histórico).
  const text = await generateLeadFollowupMessage(historyToMessages(history), attempt)
  if (!text.trim()) {
    log.warn('lead-followup: LLM retornou vazio — skip')
    return
  }

  // 5. Envia (logOutbound cuida do registro em rica_mensagens_enviadas).
  await sendWhatsApp(phone, text)
  log.info({ attempt, touches: MAX_TOUCHES }, `✅ Follow-up de lead enviado (toque ${attempt})`)

  // 6. Agenda o próximo toque (se ainda houver).
  if (attempt < MAX_TOUCHES) {
    await scheduleLeadFollowup(phone, attempt + 1)
  } else {
    log.info('lead-followup: última régua enviada — encerrando cobrança deste lead')
  }
}

// ─── sub-agente de follow-up ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a Rica, retomando UMA conversa de WhatsApp com um lead que parou de responder.

CONTEXTO:
- Você tem o histórico da conversa anterior (via mensagens).
- Sua tarefa: gerar UMA mensagem curta, humana e contextual pra reabrir a conversa DE ONDE ELA PAROU — a partir da ÚLTIMA mensagem do cliente e do que ficou em aberto.

REGRAS:
1. LEIA o histórico e identifique o último tópico/pergunta que ficou sem resposta.
2. Escreva como humano. NUNCA diga "follow-up", "tentativa", "você sumiu", "está aí?".
3. Adapte ao número do toque:
   - toque 1: leve e curioso, reabrindo ("Oi! Ficou alguma dúvida sobre o que a gente conversou? 😊")
   - toque 2: específico, retoma o tópico exato ("Oi! Sobre [tema que ele falou]...")
   - toque 3: último empurrão gentil, com um gancho ou próximo passo claro.
4. Mensagem CURTA (2-4 linhas), termina com pergunta/gancho. SEM "Olá, sou a Rica" (ele já sabe).
5. NUNCA invente informação. Se não souber o nome, não use nome.
6. Não ofereça produtos suspensos nem foge do que a pessoa demonstrou interesse.
7. SAÍDA: só o texto da mensagem, sem aspas, sem prefácio.`

async function generateLeadFollowupMessage(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  attempt: number,
): Promise<string> {
  try {
    const result = await generateText({
      model: openai(env.OPENAI_MODEL),
      temperature: 0.7,
      system: SYSTEM_PROMPT,
      messages: [
        ...history.slice(-12),
        { role: 'user', content: `[Instrução interna: gere a mensagem do toque ${attempt} de follow-up, retomando a conversa a partir da última mensagem do cliente. Só o texto.]` },
      ],
    })
    return result.text?.trim() ?? ''
  } catch (err) {
    logger.error({ err }, 'Falha no sub-agente de follow-up de lead')
    return ''
  }
}
