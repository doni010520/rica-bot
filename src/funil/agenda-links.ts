/**
 * src/funil/agenda-links.ts
 *
 * GPS — o lead agendou pelo LINK da agenda do André (manual, seções 7 a 10).
 *
 * A página de agendamento fica no CRM (/api/agendar/<token>): quando o lead
 * escolhe o horário, o CRM cria o evento no Google e marca o link como
 * 'agendado'. Este worker percebe isso (a cada AGENDA_LINK_POLL_SEGUNDOS) e:
 *   - link enviado pela RICA → handoff: briefing ao André, dono no CRM, funil em
 *     reuniao_agendada e fim da régua de follow-up. A Rica NÃO manda nada ao lead.
 *   - link enviado pelo ANDRÉ (remarcação) → só avisa o André do novo horário.
 *
 * O "claim" (processado_at) é gravado ANTES de avisar: preferimos perder um
 * aviso num crash a mandar o briefing duas vezes.
 */

import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { EXECUTIVES } from '../routing/executives.config.js'
import { atualizarFunil, funilAtual, type Campanha } from './funil.js'
import { handoffEstruturado, montarAvisoRemarcacao, dataHoraRecife } from './handoff.js'

type LinkAgendado = {
  id: string
  phone: string
  campanha: Campanha
  deal_id: string | null
  criado_por: 'rica' | 'andre'
  inicio: Date
  event_id: string | null
  lead_email: string | null
}

const PRODUTO: Record<string, string> = { gps: 'GPS Padaria', mentoria: 'Mentoria Padaria Lucrativa' }

export async function processarAgendamentos(pool: Pool): Promise<number> {
  const log = logger.child({ context: 'agenda-links' })
  const r = await pool.query<LinkAgendado>(
    `UPDATE rica_agenda_links SET processado_at = NOW()
     WHERE id IN (
       SELECT id FROM rica_agenda_links
       WHERE organization_id = $1 AND status = 'agendado' AND processado_at IS NULL
         AND agendado_at > NOW() - INTERVAL '7 days'
       ORDER BY agendado_at
       LIMIT 10
       FOR UPDATE SKIP LOCKED)
     RETURNING id, phone, campanha, deal_id, criado_por, inicio, event_id, lead_email`,
    [env.ORG_ID],
  )

  for (const l of r.rows) {
    const inicioIso = new Date(l.inicio).toISOString()
    const { data, hora } = dataHoraRecife(inicioIso)
    try {
      if (l.criado_por === 'andre') {
        const f = await funilAtual(pool, l.phone)
        await sendWhatsApp(EXECUTIVES.ANDRE.phoneFormatted, montarAvisoRemarcacao(l.phone, f?.nome ?? null, inicioIso), { crmSender: null })
        await atualizarFunil(pool, l.phone, l.campanha, {
          etapa: 'remarcado',
          campos: {
            meeting_status: 'remarcada',
            meeting_start_at: inicioIso,
            calendar_event_id: l.event_id ?? undefined,
            ...(l.lead_email ? { email: l.lead_email } : {}),
          },
          evento: 'reuniao_remarcada',
          dados: { inicio: inicioIso },
        })
        log.info({ phone: l.phone.slice(-4) }, '🔁 Reunião remarcada pelo link do André — André avisado')
        continue
      }

      await handoffEstruturado(pool, {
        telefone: l.phone,
        campanha: l.campanha,
        exec: EXECUTIVES.ANDRE,
        ficha: { produto: PRODUTO[l.campanha] ?? 'GPS Padaria', ...(l.lead_email ? { email: l.lead_email } : {}) },
        reuniao: { tipo: 'agendada', rotulo: `${data} às ${hora}`, inicioIso, eventId: l.event_id ?? '' },
        dealId: l.deal_id ?? undefined,
      })
      log.info({ phone: l.phone.slice(-4), campanha: l.campanha }, '📅 Lead agendou pelo link — briefing enviado ao André')
    } catch (err) {
      log.error({ err, link: l.id }, 'Falha ao avisar o André do agendamento')
    }
  }
  return r.rows.length
}

let _timer: ReturnType<typeof setInterval> | null = null

export function startAgendaLinksWorker(pool: Pool): void {
  if (_timer) return
  const ms = Math.max(10, env.AGENDA_LINK_POLL_SEGUNDOS) * 1000
  _timer = setInterval(() => {
    void processarAgendamentos(pool).catch((err) => logger.warn({ err }, 'agenda-links: rodada falhou'))
  }, ms)
  logger.info({ segundos: ms / 1000 }, '📅 Worker de agendamentos pelo link (GPS) iniciado')
}

export function stopAgendaLinksWorker(): void {
  if (_timer) clearInterval(_timer)
  _timer = null
}
