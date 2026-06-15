/**
 * src/reports/daily-digest.ts
 *
 * Resumo diário para a gestora (Maria Helena) — "tudo o que a Rica fez no dia".
 *
 * Cron diário (default 20h BRT) → compila a atividade do dia direto do Postgres
 * e envia um resumo no WhatsApp da Maria Helena.
 *
 * Conteúdo:
 *   • Leads novos registrados (via Rica/WhatsApp)
 *   • Encaminhados a executivos (lead → executivo)
 *   • Sem responsável (pendentes de distribuição)
 *   • Cobranças de status enviadas a executivos
 *   • Backlog acumulado (leads abertos sem dono)
 */

import cron from 'node-cron'
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { EXECUTIVES } from '../routing/executives.config.js'

const MAX_LIST = 12 // máximo de itens por lista no WhatsApp

let _cronTask: ReturnType<typeof cron.schedule> | null = null

type DigestData = {
  leadsNovos: number
  distribuidos: Array<{ nome: string; exec: string }>
  semDono: Array<{ nome: string; telefone: string; funil: string }>
  cobrancas: number
  backlog: number
}

// ─── coleta de dados ──────────────────────────────────────────────────────────

const INICIO_DO_DIA =
  `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`

async function collectDigest(pool: Pool): Promise<DigestData> {
  const org = env.ORG_ID

  const [novos, distribuidos, semDono, cobrancas, backlog] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS n FROM deals
       WHERE organization_id = $1 AND source = 'whatsapp' AND created_at >= ${INICIO_DO_DIA}`,
      [org],
    ),
    pool.query(
      `SELECT d.contact_name, d.contact_phone, u.name AS exec
       FROM deals d JOIN users u ON u.id = d.owner_id
       WHERE d.organization_id = $1 AND d.source = 'whatsapp'
         AND d.owner_id IS NOT NULL AND d.created_at >= ${INICIO_DO_DIA}
       ORDER BY d.created_at`,
      [org],
    ),
    pool.query(
      `SELECT d.contact_name, d.contact_phone, COALESCE(p.name, 'Sem funil') AS funil
       FROM deals d LEFT JOIN pipelines p ON p.id = d.pipeline_id
       WHERE d.organization_id = $1 AND d.source = 'whatsapp'
         AND d.owner_id IS NULL AND d.created_at >= ${INICIO_DO_DIA}
       ORDER BY d.created_at`,
      [org],
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM deal_activities da
       JOIN deals d ON d.id = da.deal_id
       WHERE d.organization_id = $1 AND da.type = 'exec_followup'
         AND da.created_at >= ${INICIO_DO_DIA}`,
      [org],
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM deals
       WHERE organization_id = $1 AND status = 'open' AND owner_id IS NULL`,
      [org],
    ),
  ])

  const nome = (r: { contact_name?: string | null; contact_phone?: string | null }) =>
    (r.contact_name && r.contact_name !== r.contact_phone ? r.contact_name : null) ||
    r.contact_phone ||
    'Sem nome'

  return {
    leadsNovos: novos.rows[0]?.n ?? 0,
    distribuidos: distribuidos.rows.map((r) => ({ nome: nome(r), exec: r.exec })),
    semDono: semDono.rows.map((r) => ({
      nome: nome(r),
      telefone: r.contact_phone ?? '',
      funil: r.funil,
    })),
    cobrancas: cobrancas.rows[0]?.n ?? 0,
    backlog: backlog.rows[0]?.n ?? 0,
  }
}

// ─── montagem da mensagem ───────────────────────────────────────────────────────

function formatDigest(d: DigestData): string {
  const hoje = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date())

  const linhas: string[] = []
  linhas.push(`📊 *Rica — Resumo do dia (${hoje})*`)
  linhas.push('')
  linhas.push(`🆕 Leads novos: *${d.leadsNovos}*`)
  linhas.push(`🎯 Encaminhados: *${d.distribuidos.length}*`)
  linhas.push(`⚠️ Sem responsável: *${d.semDono.length}*`)
  linhas.push(`📞 Cobranças a executivos: *${d.cobrancas}*`)

  if (d.distribuidos.length > 0) {
    linhas.push('')
    linhas.push('*Encaminhados:*')
    for (const x of d.distribuidos.slice(0, MAX_LIST)) {
      linhas.push(`• ${x.nome} → ${x.exec}`)
    }
    if (d.distribuidos.length > MAX_LIST) linhas.push(`• (+${d.distribuidos.length - MAX_LIST} mais)`)
  }

  if (d.semDono.length > 0) {
    linhas.push('')
    linhas.push('*Sem responsável (distribuir):*')
    for (const x of d.semDono.slice(0, MAX_LIST)) {
      const link = x.telefone ? ` — wa.me/${x.telefone}` : ''
      linhas.push(`• ${x.nome}${link}`)
    }
    if (d.semDono.length > MAX_LIST) linhas.push(`• (+${d.semDono.length - MAX_LIST} mais)`)
  }

  linhas.push('')
  linhas.push(`📌 Backlog: *${d.backlog}* leads abertos sem dono`)
  linhas.push('')
  linhas.push('🤖 _Rica — Assistente de Vendas_')

  return linhas.join('\n')
}

// ─── execução ───────────────────────────────────────────────────────────────────

export async function runDailyDigest(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'daily-digest' })
  try {
    const data = await collectDigest(pool)
    const message = formatDigest(data)
    await sendWhatsApp(EXECUTIVES.MARIA_HELENA.phoneFormatted, message)
    log.info(
      { leadsNovos: data.leadsNovos, distribuidos: data.distribuidos.length, semDono: data.semDono.length },
      '📊 Resumo diário enviado à gestora',
    )
  } catch (err) {
    log.error({ err }, 'Falha ao gerar/enviar resumo diário')
  }
}

// ─── agendamento ────────────────────────────────────────────────────────────────

export function startDailyDigestWorker(pool: Pool): void {
  if (_cronTask) {
    logger.warn('Daily digest worker já está rodando')
    return
  }
  if (!env.DAILY_DIGEST_ENABLED) {
    logger.info('Daily digest desabilitado — skip')
    return
  }

  _cronTask = cron.schedule(
    env.DAILY_DIGEST_CRON,
    async () => {
      await runDailyDigest(pool)
    },
    { timezone: env.FOLLOWUP_TIMEZONE, scheduled: true },
  )

  logger.info(
    { cron: env.DAILY_DIGEST_CRON, timezone: env.FOLLOWUP_TIMEZONE },
    '📅 Daily digest worker iniciado',
  )
}

export function stopDailyDigestWorker(): void {
  _cronTask?.stop()
  _cronTask = null
}
