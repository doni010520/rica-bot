/**
 * src/routing/encaminhar-lead.ts
 *
 * NÚCLEO ÚNICO de encaminhamento de lead para executivo.
 *
 * Uma Rica, um recurso, dois pontos de entrada que chamam ESTA função:
 *   - copiloto (membro do time pede: "envia esse lead pro André")
 *   - agente de atendimento (o próprio lead menciona: "me indicaram a Helen")
 *
 * Fluxo completo (paridade total):
 *   1. resolve executivo (nome explícito via alias, ou roteia por produto/região)
 *   2. registra/garante o lead no CRM (find-or-create, idempotente)
 *   3. avisa o executivo no WhatsApp
 *   4. manda cópia pra gestora (Maria Helena), exceto se ela for a designada
 *   5. define o dono no CRM (resolve por email)
 *   6. registra atividade no deal (se houver id)
 *   7. agenda a cobrança de status ao executivo
 */

import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { normalizePhone } from '../uazapi/normalize-phone.js'
import { routeToExecutive } from './executive-router.js'
import { resolveExecutiveByName, EXECUTIVES, type Executive } from './executives.config.js'
import { mapDDDToRegion } from './region-mapper.js'
import { crmRequest } from '../lib/crm-client.js'
import { scheduleExecutiveFollowup } from '../followup/executive-followup.js'

export type EncaminharLeadInput = {
  telefone: string
  nome?: string | undefined
  produto?: string | undefined
  empresa?: string | undefined
  mensagem?: string | undefined
  /** Nome do executivo de destino. Se vazio, roteia por produto/região. */
  executivo?: string | undefined
  /** UUID do deal, quando já conhecido (atividade + cobrança). */
  dealId?: string | undefined
  /** Quem pediu (membro do time) ou 'rica_ai'. */
  solicitante?: string | undefined
  /** find-or-create do lead no CRM antes de encaminhar (default: true). */
  registrar?: boolean | undefined
}

export type EncaminharLeadResult = {
  success: boolean
  executiveName?: string
  /** Mensagem amigável quando success=false (executivo não reconhecido, telefone inválido). */
  errorMessage?: string
}

export async function encaminharLead(input: EncaminharLeadInput): Promise<EncaminharLeadResult> {
  const log = logger.child({ context: 'encaminhar-lead' })

  const phone = normalizePhone(input.telefone ?? '')
  if (phone.replace(/\D/g, '').length < 12) {
    return { success: false, errorMessage: 'Não consegui identificar o telefone do lead. Me manda o número com DDD (ex: 11 96586-9590).' }
  }

  const produto = (input.produto ?? '').trim()
  const nome = (input.nome ?? '').trim()
  const empresa = (input.empresa ?? '').trim()
  const mensagem = (input.mensagem ?? '').trim()
  const solicitante = input.solicitante ?? 'rica_ai'

  // 1. Resolve o executivo: explícito ("pro André") ou roteia por produto/região
  let exec: Executive | null = input.executivo ? resolveExecutiveByName(input.executivo) : null
  if (input.executivo && !exec) {
    return { success: false, errorMessage: `Não reconheci o executivo "${input.executivo}". Me diz o nome certo (ex: André, Patrícia, Lúcia, Alex...).` }
  }
  let motivo = 'Designação manual pela equipe'
  if (!exec) {
    const r = routeToExecutive(produto, empresa, mensagem, phone)
    exec = r.executive
    motivo = r.reason
  }

  // 2. Garante o lead no CRM (find-or-create idempotente por telefone)
  if (input.registrar !== false) {
    await crmRequest('/api/crm/register-lead', {
      method: 'POST',
      body: {
        contact_name: nome || undefined,
        contact_phone: phone,
        company_name: empresa || undefined,
        pipeline_name: /gps/i.test(produto) ? 'GPS' : undefined,
        source: 'whatsapp',
        source_detail: `encaminhado_manual:${solicitante}`,
        temperature: 'warm',
      },
      operationName: 'encaminhar_register',
    }).catch((err) => log.warn({ err }, 'register-lead no encaminhamento falhou (segue)'))
  }

  // 3. Avisa o executivo no WhatsApp
  const firstName = exec.name.split(' ')[0] ?? exec.name
  const phoneLink = phone.replace(/^55/, '')
  const execMsg =
    `🎯 *LEAD DESIGNADO PRA VOCÊ, ${firstName.toUpperCase()}!*\n\n` +
    `Oi ${firstName}! 👋 Aqui é a Rica 🤖\n\n` +
    `A equipe direcionou esse lead pra você:\n\n` +
    `━━━━━━━━━━━━━━\n📋 *DADOS DO LEAD*\n━━━━━━━━━━━━━━\n\n` +
    `👤 *Nome:* ${nome || 'Não informado'}\n` +
    `📱 *Tel:* ${phone}\n` +
    `🎯 *Interesse:* ${produto || 'Não informado'}\n\n` +
    (mensagem ? `━━━━━━━━━━━━━━\n💬 *CONTEXTO*\n━━━━━━━━━━━━━━\n_"${mensagem}"_\n\n` : '') +
    `⚡ *Clique para chamar no WhatsApp:*\nwa.me/${phoneLink}\n\n` +
    `🤖 _Rica - Assistente de Vendas_`
  await sendWhatsApp(exec.phoneFormatted, execMsg)

  // 4. Cópia pra gestora (Maria Helena) — exceto se ela for a designada
  if (exec.email !== EXECUTIVES.MARIA_HELENA.email) {
    const geo = mapDDDToRegion(phone)
    const now = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date())
    const mgrMsg =
      `📊 *LEAD DESIGNADO (manual)*\n\n` +
      `👤 *Lead:* ${nome || 'Não informado'}\n` +
      `🎯 *Interesse:* ${produto || 'Não informado'}\n` +
      `📱 *Tel:* ${phone}\n` +
      `📍 *Local:* ${geo.state || 'BR'} (DDD ${geo.ddd ?? 'XX'})\n\n` +
      `➡️ *Direcionado para:* ${exec.name}\n` +
      `📋 *Motivo:* ${motivo}\n\n` +
      `⏰ ${now}`
    await sendWhatsApp(EXECUTIVES.MARIA_HELENA.phoneFormatted, mgrMsg).catch((err) => log.warn({ err }, 'cópia gestora falhou'))
  }

  // 5. Define o dono no CRM (resolve por email)
  await crmRequest('/api/crm/deals/assign-owner-by-phone', {
    method: 'POST',
    body: { phone, executivo_email: exec.email, assigned_via: 'designar_lead', assigned_by: solicitante },
    operationName: 'encaminhar_assign',
  }).catch((err) => log.warn({ err }, 'assign falhou (lead avisado mesmo assim)'))

  // 6. Atividade no deal (se houver id)
  if (input.dealId) {
    await crmRequest(`/api/crm/deals/${encodeURIComponent(input.dealId)}/activities`, {
      method: 'POST',
      body: { type: 'escalation', description: `Lead designado para ${exec.name}`, metadata: { assigned_to: exec.email, reason: motivo } },
      operationName: 'encaminhar_activity',
    }).catch(() => { /* não bloqueia */ })
  }

  // 7. Agenda cobrança de status ao executivo (gate EXEC_FOLLOWUP_ENABLED é interno)
  await scheduleExecutiveFollowup({
    executivePhone: exec.phoneFormatted,
    executiveName: exec.name,
    leadName: nome,
    leadPhone: phone,
    product: produto,
    dealId: input.dealId,
    forwardedAt: new Date().toISOString(),
    assignedVia: 'designar_lead',
  }).catch((err) => log.warn({ err }, 'agendar cobrança falhou — continuando'))

  log.info({ exec: exec.name, phone: phone.slice(-4), produto, via: input.executivo ? 'explicito' : 'roteado' }, 'Lead encaminhado')
  return { success: true, executiveName: exec.name }
}
