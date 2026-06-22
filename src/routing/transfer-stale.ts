/**
 * src/routing/transfer-stale.ts
 *
 * Transferência de leads NÃO QUALIFICADOS.
 *
 * Modelo: o lead NÃO é distribuído na chegada. A Rica tem uma janela
 * (TRANSFER_WINDOW_HOURS) pra qualificar/responder. Quem qualifica é
 * transferido na hora pela própria Rica (notificar_equipe). Quem NÃO
 * respondeu/qualificou nessa janela é varrido por este worker e transferido
 * mesmo assim — avisando o executivo que é um lead NÃO QUALIFICADO.
 *
 * Roteamento por PRODUTO (mesmo princípio de TODO lead, não só GPS):
 *   - Lê as mensagens do cliente (n8n_chat_histories) e roda pelo mesmo cérebro
 *     do notificar_equipe (routeToExecutive) → executivo certo por produto/região.
 *   - Funil GPS é honrado direto (RJ/MG → Patrícia, resto André).
 *   - Só quem o roteador NÃO consegue identificar → triagem (Malu) no CRM.
 * Só pega leads recentes (TRANSFER_MAX_AGE_DAYS) — não varre o backlog antigo.
 */

import cron from 'node-cron'
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { routeToExecutive } from './executive-router.js'
import { EXECUTIVES } from './executives.config.js'
import { crmRequest } from '../lib/crm-client.js'
import { isBusinessHour } from '../lib/timezone.js'

let _cronTask: ReturnType<typeof cron.schedule> | null = null

type Cand = { phone: string; nome: string | null; funil: string }

type LcMsg = { type?: string; data?: { content?: string }; content?: string }

/**
 * Concatena as mensagens DO CLIENTE (type=human) do histórico, pra detectar
 * o produto. Match tolerante ao 9º dígito (DDD + últimos 8 dígitos).
 */
async function loadLeadHumanText(pool: Pool, phone: string): Promise<string> {
  const digits = phone.replace(/\D/g, '')
  const ddd = digits.slice(2, 4)
  const last8 = digits.slice(-8)
  try {
    const res = await pool.query<{ message: LcMsg }>(
      `SELECT message FROM "${env.CHAT_MEMORY_TABLE}"
       WHERE regexp_replace(session_id, '\\D', '', 'g') LIKE $1
         AND regexp_replace(session_id, '\\D', '', 'g') LIKE $2
       ORDER BY id ASC
       LIMIT 20`,
      [`%${last8}`, `55${ddd}%`],
    )
    return res.rows
      .map((r) => r.message)
      .filter((m) => m?.type === 'human')
      .map((m) => m?.data?.content ?? m?.content ?? '')
      .join(' ')
      .slice(0, 2000)
  } catch {
    return ''
  }
}

async function assignOwner(phone: string, email: string, via: string): Promise<void> {
  await crmRequest('/api/crm/deals/assign-owner-by-phone', {
    method: 'POST',
    body: { phone, executivo_email: email, assigned_via: via, assigned_by: 'rica_ai' },
    operationName: 'assign_nao_qualificado',
  }).catch((err) => logger.warn({ err }, 'assign não qualificado falhou'))
}

function naoQualificadoMsg(execName: string, nome: string, phone: string, produto: string): string {
  const first = execName.split(' ')[0] ?? execName
  const link = phone.replace(/^55/, '')
  return (
    `🔔 *LEAD NÃO QUALIFICADO*\n\n` +
    `Oi ${first}! Esse lead chegou pela Rica mas não respondeu / não qualificou no prazo. ` +
    `Te passo pra você avaliar e dar sequência:\n\n` +
    `👤 ${nome || 'Não informado'}\n` +
    `📱 wa.me/${link}\n` +
    `🎯 ${produto}\n\n` +
    `🤖 Rica`
  )
}

export async function runStaleTransfer(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'transfer-stale' })
  try {
    const res = await pool.query<Cand>(
      `SELECT d.contact_phone AS phone, d.contact_name AS nome, COALESCE(p.name,'') AS funil
       FROM deals d LEFT JOIN pipelines p ON p.id = d.pipeline_id
       WHERE d.organization_id = $1 AND d.status = 'open' AND d.owner_id IS NULL AND d.source = 'whatsapp'
         AND d.created_at <= now() - make_interval(hours => $2::int)
         AND d.created_at >= now() - make_interval(days  => $3::int)
         AND (d.last_client_message_at IS NULL OR d.last_client_message_at < now() - interval '3 hours')
       ORDER BY d.created_at
       LIMIT 40`,
      [env.ORG_ID, env.TRANSFER_WINDOW_HOURS, env.TRANSFER_MAX_AGE_DAYS],
    )
    if (res.rows.length === 0) {
      log.debug('Nenhum lead não qualificado para transferir')
      return
    }

    let ok = 0
    for (const c of res.rows) {
      try {
        // Funil GPS é honrado direto; senão detecta o produto pela conversa do cliente.
        const r = /gps/i.test(c.funil)
          ? routeToExecutive('GPS', '', '', c.phone)
          : await loadLeadHumanText(pool, c.phone).then((t) => routeToExecutive(t, '', t, c.phone))

        // Maria Helena só aparece no fallback do roteador = produto não identificado → Malu.
        if (r.executive === EXECUTIVES.MARIA_HELENA) {
          await assignOwner(c.phone, env.TRIAGE_EMAIL, 'transfer_nao_qualificado_triagem')
        } else {
          const produto = r.reason.split('—')[0]?.trim() || 'Não informado'
          await sendWhatsApp(r.executive.phoneFormatted, naoQualificadoMsg(r.executive.name, c.nome ?? '', c.phone, produto))
          await assignOwner(c.phone, r.executive.email, 'transfer_nao_qualificado')
        }
        ok++
      } catch (err) {
        log.warn({ err, phone: c.phone.slice(-4) }, 'Falha ao transferir lead não qualificado')
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    log.info({ transferidos: ok, total: res.rows.length }, 'Transferência de não qualificados concluída')
  } catch (err) {
    log.error({ err }, 'Falha no ciclo de transferência de não qualificados')
  }
}

export function startStaleTransferWorker(pool: Pool): void {
  if (_cronTask) {
    logger.warn('Stale transfer worker já está rodando')
    return
  }
  if (!env.TRANSFER_ENABLED) {
    logger.info('Transferência de não qualificados desabilitada — skip')
    return
  }
  _cronTask = cron.schedule(
    env.TRANSFER_CRON,
    async () => {
      if (isBusinessHour()) await runStaleTransfer(pool)
    },
    { timezone: env.FOLLOWUP_TIMEZONE, scheduled: true },
  )
  logger.info({ cron: env.TRANSFER_CRON, windowH: env.TRANSFER_WINDOW_HOURS }, '📅 Worker de transferência (não qualificados) iniciado')
}

export function stopStaleTransferWorker(): void {
  _cronTask?.stop()
  _cronTask = null
}
