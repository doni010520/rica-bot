/**
 * src/reports/funil-semanal.ts
 *
 * Painel SEMANAL do funil por campanha — "Playbook do André", seção 13.1:
 * separar "a campanha gera leads?", "a Rica transforma clique em conversa
 * qualificada?" e "o André transforma qualificação em venda?".
 *
 * Toda segunda (FUNIL_SEMANAL_CRON) manda para a força-tarefa comercial
 * (Isabell, Jéssica, Maria Helena — FUNIL_SEMANAL_CONTATOS) os números dos
 * últimos 7 dias por campanha, com as metas iniciais do playbook e a etapa
 * onde mais leads ficaram parados (o gargalo da semana).
 */

import cron from 'node-cron'
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { parseContatos } from '../routing/executives.config.js'

const NOME: Record<string, string> = {
  mentoria: 'Mentoria Coletiva',
  jdl: 'Jornada Online',
  gps: 'GPS Padaria',
  outro: 'Outros',
}

type Linha = {
  campanha: string
  leads: number
  contatou: number
  responderam: number
  diagnostico: number
  dor: number
  qualificados: number
  reunioes: number
  transferidos: number
  links: number
  compras: number
  nutricao: number
  links_agenda: number
  confirmadas: number
  realizadas: number
  no_shows: number
  vendas: number
  horas_ate_agendar: string | null
  parados_etapa: string | null
  parados_qtd: number | null
}

function pct(a: number, b: number): string {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : '—'
}

function meta(valor: number, total: number, alvo: number): string {
  if (total === 0) return ''
  return valor / total >= alvo ? ' ✅' : ' ⚠️'
}

export async function coletarFunilSemanal(pool: Pool): Promise<Linha[]> {
  const r = await pool.query<Linha>(
    `WITH f AS (
       SELECT * FROM rica_lead_funil
       WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
     ), parados AS (
       SELECT DISTINCT ON (campanha) campanha, etapa, count(*) OVER (PARTITION BY campanha, etapa)::int AS qtd
       FROM f
       WHERE etapa NOT IN ('reuniao_agendada','transferido','compra_confirmada','nao_contatar',
                           'confirmado_andre','reuniao_realizada','no_show','remarcado','vendido')
       ORDER BY campanha, count(*) OVER (PARTITION BY campanha, etapa) DESC
     )
     SELECT f.campanha,
            count(*)::int AS leads,
            count(*) FILTER (WHERE f.first_rica_message_at IS NOT NULL)::int AS contatou,
            count(*) FILTER (WHERE f.first_lead_reply_at IS NOT NULL)::int AS responderam,
            count(*) FILTER (WHERE f.etapa NOT IN ('novo','rica_iniciou','engajou','nutricao','nao_contatar','perdido') OR f.dor_principal IS NOT NULL)::int AS diagnostico,
            count(*) FILTER (WHERE f.dor_principal IS NOT NULL)::int AS dor,
            count(*) FILTER (WHERE f.qualified_at IS NOT NULL)::int AS qualificados,
            count(*) FILTER (WHERE f.meeting_booked_at IS NOT NULL)::int AS reunioes,
            count(*) FILTER (WHERE f.handoff_at IS NOT NULL)::int AS transferidos,
            count(*) FILTER (WHERE f.link_enviado_at IS NOT NULL)::int AS links,
            count(*) FILTER (WHERE f.compra_confirmada_at IS NOT NULL)::int AS compras,
            count(*) FILTER (WHERE f.etapa = 'nutricao')::int AS nutricao,
            count(*) FILTER (WHERE f.link_agenda_enviado_at IS NOT NULL)::int AS links_agenda,
            count(*) FILTER (WHERE f.confirmado_andre_at IS NOT NULL)::int AS confirmadas,
            count(*) FILTER (WHERE f.reuniao_realizada_at IS NOT NULL)::int AS realizadas,
            count(*) FILTER (WHERE f.no_show_at IS NOT NULL)::int AS no_shows,
            count(*) FILTER (WHERE f.resultado = 'vendido')::int AS vendas,
            round(avg(EXTRACT(EPOCH FROM (f.meeting_booked_at - f.created_at)) / 3600)
              FILTER (WHERE f.meeting_booked_at IS NOT NULL)::numeric, 1)::text AS horas_ate_agendar,
            max(p.etapa) AS parados_etapa, max(p.qtd) AS parados_qtd
     FROM f LEFT JOIN parados p ON p.campanha = f.campanha
     GROUP BY f.campanha
     ORDER BY leads DESC`,
    [env.ORG_ID],
  )
  return r.rows
}

export function formatarFunilSemanal(linhas: Linha[]): string {
  const out: string[] = ['📈 *Rica — Funil da semana (últimos 7 dias)*', '']
  if (linhas.length === 0) {
    out.push('Nenhum lead de campanha registrado nesta semana.')
  }
  for (const l of linhas) {
    const base = l.contatou || l.leads
    out.push(`*${NOME[l.campanha] ?? l.campanha}*`)
    out.push(`• Leads: *${l.leads}* · responderam: ${l.responderam} (${pct(l.responderam, base)}${meta(l.responderam, base, 0.55)})`)
    out.push(`• Diagnóstico: ${l.diagnostico} (${pct(l.diagnostico, l.responderam)}${meta(l.diagnostico, l.responderam, 0.7)}) · dor identificada: ${l.dor} (${pct(l.dor, l.diagnostico)}${meta(l.dor, l.diagnostico, 0.8)})`)
    out.push(`• Qualificados: ${l.qualificados} (${pct(l.qualificados, l.responderam)})`)
    if (l.campanha === 'mentoria') {
      out.push(`• Reuniões com André: *${l.reunioes}* · transferidos: ${l.transferidos} (aceite ${pct(l.transferidos, l.qualificados)}${meta(l.transferidos, l.qualificados, 0.75)})`)
    } else if (l.campanha === 'gps') {
      // Manual GPS, seção 19
      out.push(`• Links da agenda: ${l.links_agenda} (${pct(l.links_agenda, l.qualificados)} dos qualificados) · agendaram: *${l.reunioes}* (${pct(l.reunioes, l.links_agenda)})`)
      out.push(`• Confirmadas pelo André: ${l.confirmadas} (${pct(l.confirmadas, l.reunioes)}) · realizadas: ${l.realizadas} (show rate ${pct(l.realizadas, l.reunioes)}) · no-show: ${l.no_shows}`)
      out.push(`• Vendas do André: *${l.vendas}* (${pct(l.vendas, l.realizadas)} das realizadas · ${pct(l.vendas, l.leads)} dos leads)`)
      if (l.horas_ate_agendar) out.push(`• Tempo médio até agendar: ${l.horas_ate_agendar.replace('.', ',')}h`)
    } else if (l.campanha === 'jdl') {
      out.push(`• Links enviados: *${l.links}* · compras informadas: ${l.compras} · para o André: ${l.transferidos}`)
    } else {
      out.push(`• Transferidos: ${l.transferidos}`)
    }
    if (l.nutricao) out.push(`• Sem resposta após a cadência: ${l.nutricao}`)
    if (l.parados_etapa) out.push(`• 🔎 Gargalo: *${l.parados_qtd}* parados em "${l.parados_etapa.replace(/_/g, ' ')}"`)
    out.push('')
  }
  out.push('_Metas iniciais do playbook: resposta ≥55%, diagnóstico ≥70%, dor ≥80%, aceite do handoff ≥75%._')
  out.push('_Detalhes a qualquer hora: pergunte ao copiloto "como está o funil da Mentoria essa semana?"_')
  out.push('')
  out.push('🤖 _Rica_')
  return out.join('\n')
}

export async function runFunilSemanal(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'funil-semanal' })
  try {
    const texto = formatarFunilSemanal(await coletarFunilSemanal(pool))
    for (const c of parseContatos(env.FUNIL_SEMANAL_CONTATOS)) {
      await sendWhatsApp(c.phone, texto, { crmSender: null }).catch((err) => log.warn({ err }, 'envio do painel falhou'))
    }
    log.info('📈 Painel semanal do funil enviado')
  } catch (err) {
    log.error({ err }, 'Falha no painel semanal do funil')
  }
}

let _cron: ReturnType<typeof cron.schedule> | null = null

export function startFunilSemanalWorker(pool: Pool): void {
  if (_cron) return
  _cron = cron.schedule(env.FUNIL_SEMANAL_CRON, () => void runFunilSemanal(pool), {
    timezone: env.FOLLOWUP_TIMEZONE,
    scheduled: true,
  })
  logger.info({ cron: env.FUNIL_SEMANAL_CRON }, '📈 Painel semanal do funil iniciado')
}

export function stopFunilSemanalWorker(): void {
  _cron?.stop()
  _cron = null
}
