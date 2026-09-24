/**
 * src/funil/handoff.ts
 *
 * Handoff ESTRUTURADO de lead para o executivo (Mentoria Coletiva, set/2026).
 *
 * A especificação proíbe "transferir para André sem resumo estruturado": o
 * André recebe uma conversa em andamento, não um lead. Esta mensagem leva a
 * ficha completa (dor, objetivo com as palavras do lead, pilar, temperatura...)
 * e, quando houver, o dia e a hora da reunião de 30 min já marcada.
 *
 * Mesmo pós-processo do encaminhamento comum: cópia para a gestora, dono no
 * CRM, atividade no deal e cobrança de status ao executivo.
 */

import type { Pool } from 'pg'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { whatsappLink } from '../uazapi/normalize-phone.js'
import { EXECUTIVES, type Executive } from '../routing/executives.config.js'
import { crmRequest } from '../lib/crm-client.js'
import { scheduleExecutiveFollowup } from '../followup/executive-followup.js'
import { atualizarFunil, funilAtual, type CamposFunil, type Campanha } from './funil.js'

export type Ficha = CamposFunil & { produto?: string | undefined }

export type SituacaoReuniao =
  | { tipo: 'agendada'; rotulo: string; inicioIso: string; eventId: string }
  | { tipo: 'sem_horario' }          // hoje e amanhã lotados → contato manual imediato
  | { tipo: 'pediu_outra_data'; pedido: string }
  | { tipo: 'agenda_nao_conectada' }
  | { tipo: 'sem_reuniao' }          // handoff direto (ex.: lead pediu para falar agora)

const ROTULO_CAMPO: Array<[keyof Ficha, string]> = [
  ['nome', '👤 Nome'],
  ['padaria', '🏪 Padaria'],
  ['origem', '📣 Origem'],
  ['interesse_do_anuncio', '👀 O que chamou atenção'],
  ['dor_principal', '🔥 Dor principal'],
  ['impacto', '📉 Impacto'],
  ['objetivo_declarado', '🎯 Objetivo (palavras do lead)'],
  ['pilar_aderente', '🧭 Pilar da Mentoria'],
  ['decisor', '🔑 Decide?'],
  ['tamanho_operacao', '👥 Tamanho'],
  ['temperatura', '🌡️ Temperatura'],
  ['pergunta_de_compra', '💬 Pergunta de compra'],
  ['objecao', '🚧 Objeção'],
]

function linhaReuniao(s: SituacaoReuniao): string {
  switch (s.tipo) {
    case 'agendada':
      return `📅 *REUNIÃO MARCADA:* ${s.rotulo} (30 min) — já está na sua agenda.`
    case 'sem_horario':
      return '⚠️ *SEM HORÁRIO HOJE E AMANHÃ na sua agenda.* Chame o lead AGORA para combinar.'
    case 'pediu_outra_data':
      return `🗓️ *Lead pediu outra data:* "${s.pedido}". Decida e combine com ele.`
    case 'agenda_nao_conectada':
      return '⚠️ Sua agenda Google não está conectada no CRM — chame o lead para marcar a conversa.'
    default:
      return '⚡ Lead pronto para continuar — chame agora.'
  }
}

export function montarFichaParaExecutivo(
  exec: Executive,
  telefone: string,
  ficha: Ficha,
  reuniao: SituacaoReuniao,
): string {
  const primeiro = exec.name.split(' ')[0] ?? exec.name
  const linhas: string[] = []
  linhas.push(`🎯 *LEAD DA ${(ficha.produto || 'MENTORIA').toUpperCase()} PRA VOCÊ, ${primeiro.toUpperCase()}!*`)
  linhas.push('')
  linhas.push(linhaReuniao(reuniao))
  linhas.push('')
  linhas.push('━━━━━━━━━━━━━━\n📋 *FICHA DA RICA*\n━━━━━━━━━━━━━━')
  for (const [campo, rotulo] of ROTULO_CAMPO) {
    const v = ficha[campo]
    if (typeof v === 'string' && v.trim()) linhas.push(`${rotulo}: ${v.trim()}`)
  }
  linhas.push(`📱 Tel: ${telefone}`)
  linhas.push('')
  linhas.push('💡 _Não recomece o atendimento: confirme a dor, aprofunde o impacto e siga para a decisão._')
  linhas.push('')
  linhas.push(`⚡ *WhatsApp do lead:* ${whatsappLink(telefone)}`)
  linhas.push('')
  linhas.push('🤖 _Rica - Assistente de Vendas_')
  return linhas.join('\n')
}

/** Resumo em texto corrido para a descrição do evento/atividade. */
export function resumoDaFicha(ficha: Ficha): string {
  return ROTULO_CAMPO
    .map(([c, r]) => {
      const v = ficha[c]
      return typeof v === 'string' && v.trim() ? `${r.replace(/^\S+\s/, '')}: ${v.trim()}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Entrega o lead ao executivo com a ficha. Completa a ficha com o que já está
 * gravado no funil (a Rica pode ter registrado a dor turnos antes).
 */
export async function handoffEstruturado(
  pool: Pool,
  opts: {
    telefone: string
    campanha: Campanha
    exec: Executive
    ficha: Ficha
    reuniao: SituacaoReuniao
    dealId?: string | undefined
  },
): Promise<void> {
  const { telefone, campanha, exec, reuniao, dealId } = opts
  const log = logger.child({ context: 'handoff', phone: telefone.slice(-4) })

  // Completa com o funil gravado (o que a Rica passou agora tem prioridade).
  const gravado = await funilAtual(pool, telefone)
  const ficha = { ...(gravado ?? {}), ...stripVazios(opts.ficha) } as unknown as Ficha

  await sendWhatsApp(exec.phoneFormatted, montarFichaParaExecutivo(exec, telefone, ficha, reuniao), { crmSender: null })

  if (exec.email !== EXECUTIVES.MARIA_HELENA.email) {
    const copia =
      `📊 *HANDOFF ${campanha.toUpperCase()}*\n\n` +
      `👤 ${ficha.nome || 'Lead'}${ficha.padaria ? ` — ${ficha.padaria}` : ''}\n` +
      `🔥 ${ficha.dor_principal || 'dor não registrada'}\n` +
      `➡️ ${exec.name}\n` +
      `${reuniao.tipo === 'agendada' ? `📅 ${reuniao.rotulo}` : `⚠️ ${reuniao.tipo.replace(/_/g, ' ')}`}`
    await sendWhatsApp(EXECUTIVES.MARIA_HELENA.phoneFormatted, copia, { crmSender: null }).catch(() => {})
  }

  await crmRequest('/api/crm/deals/assign-owner-by-phone', {
    method: 'POST',
    body: { phone: telefone, executivo_email: exec.email, assigned_via: `handoff_${campanha}`, assigned_by: 'rica_ai' },
    operationName: 'handoff_assign',
  }).catch((err) => log.warn({ err }, 'assign falhou (executivo avisado mesmo assim)'))

  if (dealId) {
    await crmRequest(`/api/crm/deals/${encodeURIComponent(dealId)}/activities`, {
      method: 'POST',
      body: {
        type: 'escalation',
        description: `Handoff ${campanha} para ${exec.name}. ${linhaReuniao(reuniao).replace(/\*/g, '')}\n\n${resumoDaFicha(ficha)}`,
        metadata: { executive_email: exec.email, campanha, reuniao: reuniao.tipo, ficha },
      },
      operationName: 'handoff_activity',
    }).catch(() => {})
  }

  await atualizarFunil(pool, telefone, campanha, {
    etapa: reuniao.tipo === 'agendada' ? 'reuniao_agendada' : 'transferido',
    campos: {
      ...stripVazios(opts.ficha),
      consentimento_handoff: true,
      meeting_status:
        reuniao.tipo === 'agendada' ? 'agendada'
        : reuniao.tipo === 'sem_horario' ? 'sem_horario'
        : reuniao.tipo === 'pediu_outra_data' ? 'pediu_outra_data'
        : reuniao.tipo === 'agenda_nao_conectada' ? 'agenda_nao_conectada'
        : 'sem_reuniao',
      ...(reuniao.tipo === 'agendada'
        ? { meeting_start_at: reuniao.inicioIso, meeting_duration_minutes: 30, calendar_event_id: reuniao.eventId }
        : {}),
    },
    evento: 'handoff',
    dados: { executivo: exec.name, reuniao },
  })

  await scheduleExecutiveFollowup({
    executivePhone: exec.phoneFormatted,
    executiveName: exec.name,
    leadName: ficha.nome ?? '',
    leadPhone: telefone,
    product: ficha.produto ?? 'Mentoria Padaria Lucrativa',
    dealId,
    forwardedAt: new Date().toISOString(),
    assignedVia: 'notificar_equipe',
  }).catch((err) => log.warn({ err }, 'agendar cobrança falhou — continuando'))

  log.info({ exec: exec.name, campanha, reuniao: reuniao.tipo }, 'Handoff estruturado enviado')
}

function stripVazios<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())),
  ) as Partial<T>
}
