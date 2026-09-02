/**
 * src/followup/executive-followup.ts
 *
 * Cobrança de status ao executivo — 24h após encaminhamento de lead.
 * Exceção: se o horário calculado cair no domingo → adia para segunda 09h BRT.
 * Sábado é válido (diferente do calculateBusinessHourDelayMs).
 *
 * Fluxo:
 *   1. notificar_equipe ou designar_lead chama scheduleExecutiveFollowup()
 *   2. BullMQ agenda job com delay de 24h (exceto domingo)
 *   3. Worker dispara: envia WhatsApp para executivo + cópia Maria Helena
 *   4. Registra atividade no CRM (deal)
 *
 * Quem recebe: resolvido na HORA DE ENVIAR, nao no agendamento. Um job de 24h
 * atras pode apontar para alguem que ja saiu da empresa.
 *
 * Dedup: jobId = exec-fu-{execPhone}-{leadPhone}
 *   → Se mesmo lead for re-encaminhado ao mesmo executivo, cancela cobrança anterior.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { isBusinessHour } from '../lib/timezone.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { EXECUTIVES, resolveExecutiveByName } from '../routing/executives.config.js'
import { crmRequest } from '../lib/crm-client.js'
import { whatsappLink } from '../uazapi/normalize-phone.js'

// ─── tipos ───────────────────────────────────────────────────────────────────

const QUEUE_NAME = 'rica-exec-followup'

export type ExecFollowupData = {
  executivePhone: string    // com 55 (formato uazapi)
  executiveName: string
  leadName: string
  leadPhone: string
  product: string
  dealId?: string | undefined
  forwardedAt: string       // ISO timestamp
  assignedVia: 'notificar_equipe' | 'designar_lead'
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
    maxRetriesPerRequest: null as null, // obrigatório para BullMQ
  }
}

function getQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: getRedisOpts(),
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
    })
  }
  return _queue
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Agenda cobrança de status para o executivo.
 * Chamado após notificar_equipe ou designar_lead com sucesso.
 *
 * Se o mesmo lead+executivo já tem cobrança pendente, cancela a anterior.
 */
export async function scheduleExecutiveFollowup(data: ExecFollowupData): Promise<void> {
  if (!env.EXEC_FOLLOWUP_ENABLED) {
    logger.debug('Executive followup desabilitado — skip')
    return
  }

  const queue = getQueue()
  const delayMs = calculateFollowupDelayMs(env.EXEC_FOLLOWUP_DELAY_HOURS)

  // jobId sem ":" — BullMQ usa ":" como separador interno
  const jobId = `exec-fu-${data.executivePhone}-${data.leadPhone}`

  // Upsert: cancela anterior (se existir) e agenda novo
  await queue.remove(jobId).catch(() => null)
  await queue.add('followup', data, { jobId, delay: delayMs })

  const delayH = (delayMs / 3_600_000).toFixed(1)
  logger.info(
    { executive: data.executiveName, lead: data.leadName, delayH, jobId },
    `📋 Cobrança de status agendada (${delayH}h)`,
  )
}

/**
 * Inicia o worker que processa cobranças de status.
 * Chamado no boot (src/index.ts).
 */
export function startExecutiveFollowupWorker(): Worker {
  if (_worker) return _worker

  _worker = new Worker(
    QUEUE_NAME,
    async (job: Job<ExecFollowupData>) => {
      await processExecutiveFollowup(job.data)
    },
    { connection: getRedisOpts(), concurrency: 5 },
  )

  _worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Executive followup job falhou')
  })

  _worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, '✅ Executive followup job concluído')
  })

  logger.info('📋 Executive followup worker iniciado')
  return _worker
}

/**
 * Encerra queue e worker. Chamado no shutdown.
 */
export async function closeExecutiveFollowup(): Promise<void> {
  await _worker?.close()
  await _queue?.close()
  _worker = null
  _queue = null
}

// ─── processamento do job ────────────────────────────────────────────────────

async function processExecutiveFollowup(data: ExecFollowupData): Promise<void> {
  const log = logger.child({
    context: 'exec-followup',
    executive: data.executiveName,
    lead: data.leadName,
  })

  log.info('Processando cobrança de status')

  // 0. Quem recebe a cobrança se decide AGORA, não no agendamento.
  //    O job dorme 24h com o executivo congelado no payload; se a pessoa saiu
  //    da empresa nesse meio-tempo, a cobrança cai num número que ninguém lê
  //    mais — foi o que aconteceu com a Patrícia em 01/09/2026.
  //    resolveExecutiveByName já aponta quem saiu para o sucessor.
  const atual = resolveExecutiveByName(data.executiveName)
  const destino = {
    name: atual?.name ?? data.executiveName,
    phone: atual?.phoneFormatted ?? data.executivePhone,
  }
  if (destino.phone !== data.executivePhone) {
    log.info(
      { de: data.executiveName, para: destino.name },
      'Cobrança redirecionada: o executivo do agendamento saiu da empresa',
    )
  }

  // 1. Monta mensagem para o executivo
  const firstName = destino.name.split(' ')[0] ?? destino.name
  const linkDoLead = whatsappLink(data.leadPhone)

  const execMessage =
    `Oi ${firstName}! 👋 Aqui é a Rica.\n\n` +
    `Encaminhamos um lead pra você:\n\n` +
    `👤 *${data.leadName || 'Não informado'}*\n` +
    `📱 ${linkDoLead}\n` +
    `🎯 ${data.product || 'Não informado'}\n\n` +
    `Conseguiu falar com ele(a)? Como foi?\n` +
    `Me atualiza pra eu registrar no sistema! 😊\n\n` +
    `🤖 _Rica - Assistente de Vendas_`

  // 2. Envia WhatsApp para o executivo
  try {
    await sendWhatsApp(destino.phone, execMessage)
    log.info({ phone: destino.phone.slice(-4) }, 'Cobrança enviada ao executivo')
  } catch (err) {
    log.error({ err }, 'Falha ao enviar cobrança ao executivo')
    throw err // BullMQ faz retry
  }

  // 3. Envia cópia para Maria Helena (gestora)
  //    Se MH é a executiva → não duplica (mesma lógica de notificar_equipe)
  if (destino.phone !== EXECUTIVES.MARIA_HELENA.phoneFormatted) {
    const mhMessage =
      `📊 *COBRANÇA DE STATUS ENVIADA*\n\n` +
      `👤 *Lead:* ${data.leadName || 'Não informado'}\n` +
      `🎯 *Interesse:* ${data.product || 'Não informado'}\n` +
      `📱 *Tel:* ${data.leadPhone}\n\n` +
      `➡️ *Executivo cobrado:* ${destino.name}\n` +
      `📋 *Via:* ${data.assignedVia === 'designar_lead' ? 'Designação manual' : 'Roteamento automático'}\n\n` +
      `⏰ Cobrança automática ${env.EXEC_FOLLOWUP_DELAY_HOURS}h após encaminhamento`

    try {
      await sendWhatsApp(EXECUTIVES.MARIA_HELENA.phoneFormatted, mhMessage)
    } catch (err) {
      log.warn({ err }, 'Falha ao enviar cópia gestora da cobrança')
      // Não faz throw — a cobrança principal já foi enviada
    }
  }

  // 4. Registra atividade no CRM
  if (data.dealId) {
    try {
      await crmRequest(`/api/crm/deals/${encodeURIComponent(data.dealId)}/activities`, {
        method: 'POST',
        body: {
          type: 'exec_followup',
          description: `Cobrança de status enviada para ${destino.name}`,
          metadata: {
            executive_phone: destino.phone,
            lead_phone: data.leadPhone,
            assigned_via: data.assignedVia,
          },
        },
        operationName: 'registrar_cobranca_exec',
      })
    } catch (err) {
      log.warn({ err }, 'Falha ao registrar cobrança no CRM')
    }
  }
}

// ─── cálculo de delay ────────────────────────────────────────────────────────

/**
 * Calcula delay para o followup de executivos.
 * Regra: exatamente N horas após o encaminhamento.
 * ÚNICA exceção: se cair no domingo BRT → empurra para segunda 09h BRT.
 * Sábado é válido (não pula para segunda como calculateBusinessHourDelayMs fazia).
 */
function calculateFollowupDelayMs(hours: number): number {
  const now = Date.now()
  const rawTarget = new Date(now + hours * 3_600_000)

  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
  }).formatToParts(rawTarget)
  const weekday = parts.find((p) => p.type === 'weekday')?.value.toLowerCase() ?? ''

  if (weekday.startsWith('dom')) {
    return nextMondayNineAMBRT(rawTarget).getTime() - now
  }

  return hours * 3_600_000
}

/**
 * Dado um Date que cai num domingo BRT, retorna segunda-feira seguinte às 09:00 BRT.
 */
function nextMondayNineAMBRT(from: Date): Date {
  let candidate = new Date(from.getTime() + 24 * 3_600_000)
  for (let i = 0; i < 7; i++) {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      weekday: 'short',
    }).formatToParts(candidate)
    const wd = parts.find((p) => p.type === 'weekday')?.value.toLowerCase() ?? ''
    if (wd.startsWith('seg')) {
      const dateParts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(candidate).map((p) => [p.type, p.value]),
      )
      return new Date(`${dateParts['year']}-${dateParts['month']}-${dateParts['day']}T09:00:00-03:00`)
    }
    candidate = new Date(candidate.getTime() + 24 * 3_600_000)
  }
  return candidate
}

/**
 * Calcula delay em ms para que o job dispare ≥ N horas depois,
 * ajustado para cair em horário comercial (9h–18h seg-sex BRT).
 * Mantido para compatibilidade — o followup de executivos usa calculateFollowupDelayMs.
 */
export function calculateBusinessHourDelayMs(hours: number): number {
  const now = Date.now()
  const rawTargetMs = now + hours * 3_600_000
  const rawTarget = new Date(rawTargetMs)

  // Se cai em horário comercial, usa direto
  if (isBusinessHour(rawTarget)) {
    return hours * 3_600_000
  }

  // Senão, avança para o próximo 9h BRT em dia útil
  return nextBusinessDay9amBRT(rawTarget).getTime() - now
}

/**
 * Dado um Date fora do horário comercial BRT, retorna o próximo
 * 9:00 BRT que caia em dia útil (seg-sex).
 *
 * Brasil não tem horário de verão desde 2019 → BRT = UTC-03:00 sempre.
 */
function nextBusinessDay9amBRT(from: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  })

  const parts = Object.fromEntries(
    fmt.formatToParts(from).map((p) => [p.type, p.value]),
  )
  const hour = parseInt(parts['hour'] ?? '0', 10)

  let candidateISO: string

  if (hour < 9) {
    // Antes de 9h → tenta 9h do mesmo dia
    candidateISO = `${parts['year']}-${parts['month']}-${parts['day']}T09:00:00-03:00`
  } else {
    // 18h+ (ou 9-18 num fim de semana) → avança pra amanhã 9h
    const nextDay = new Date(from.getTime() + 24 * 3_600_000)
    const np = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(nextDay).map((p) => [p.type, p.value]),
    )
    candidateISO = `${np['year']}-${np['month']}-${np['day']}T09:00:00-03:00`
  }

  let candidate = new Date(candidateISO)

  // Pula finais de semana (max 3 iterações: sáb→dom→seg)
  for (let i = 0; i < 4; i++) {
    if (isBusinessHour(candidate)) return candidate
    candidate = new Date(candidate.getTime() + 24 * 3_600_000)
  }

  // Fallback (nunca deve chegar aqui)
  return candidate
}

/** Exposto apenas para teste: o worker real chama isto pelo BullMQ. */
export const __test_processExecutiveFollowup = processExecutiveFollowup
