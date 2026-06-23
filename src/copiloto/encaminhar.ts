/**
 * src/copiloto/encaminhar.ts
 *
 * Encaminhamento MANUAL de lead por um membro do time (copiloto WhatsApp).
 *
 * Quando a Malu (ou outro membro) diz "envia esse lead pro André", o copiloto
 * (LLM na CRM API) interpreta e devolve uma ação; o BOT executa aqui, porque é
 * ele que conhece o telefone de cada executivo (env), o cérebro de roteamento e
 * o sendWhatsApp. O dono no CRM é resolvido por email (igual ao notificar_equipe).
 */

import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { normalizePhone } from '../uazapi/normalize-phone.js'
import { routeToExecutive, buildExecutiveMessage } from '../routing/executive-router.js'
import { resolveExecutiveByName, type Executive } from '../routing/executives.config.js'
import { mapDDDToRegion } from '../routing/region-mapper.js'
import { crmRequest } from '../lib/crm-client.js'

export type EncaminharParams = {
  telefone: string
  nome?: string
  produto?: string
  empresa?: string
  /** Nome do executivo de destino. Se vazio, roteia por produto/região. */
  executivo?: string
  /** Quem pediu o encaminhamento (membro do time). */
  solicitante?: string
}

export async function encaminharLeadManual(p: EncaminharParams): Promise<string> {
  const log = logger.child({ context: 'encaminhar-manual' })
  const phone = normalizePhone(p.telefone ?? '')
  if (phone.replace(/\D/g, '').length < 12) {
    return '❌ Não consegui identificar o telefone do lead. Me manda o número com DDD (ex: 11 96586-9590).'
  }

  const produto = (p.produto ?? '').trim()
  const nome = (p.nome ?? '').trim()
  const empresa = (p.empresa ?? '').trim()

  // 1. Resolve o executivo: explícito ("pro André") ou roteia por produto/região
  let exec: Executive | null = p.executivo ? resolveExecutiveByName(p.executivo) : null
  if (p.executivo && !exec) {
    return `❌ Não reconheci o executivo "${p.executivo}". Me diz o nome certo (ex: André, Patrícia, Lúcia, Alex...).`
  }
  if (!exec) {
    exec = routeToExecutive(produto, empresa, '', phone).executive
  }

  const geo = mapDDDToRegion(phone)

  // 2. Garante o lead no CRM (find-or-create idempotente por telefone)
  await crmRequest('/api/crm/register-lead', {
    method: 'POST',
    body: {
      contact_name: nome || undefined,
      contact_phone: phone,
      company_name: empresa || undefined,
      pipeline_name: /gps/i.test(produto) ? 'GPS' : undefined,
      source: 'whatsapp',
      source_detail: `encaminhado_manual:${p.solicitante ?? ''}`,
      temperature: 'warm',
    },
    operationName: 'encaminhar_register',
  }).catch((err) => log.warn({ err }, 'register-lead no encaminhamento falhou (segue)'))

  // 3. Avisa o executivo no WhatsApp
  const msg = buildExecutiveMessage({
    executiveName: exec.name,
    leadName: nome,
    leadPhone: phone,
    leadCompany: empresa,
    leadEmail: '',
    product: produto || 'Não informado',
    message: `Lead encaminhado por ${p.solicitante ?? 'um membro do time'}`,
    state: geo.state,
    ddd: geo.ddd,
  })
  await sendWhatsApp(exec.phoneFormatted, msg)

  // 4. Define o dono no CRM (resolve por email)
  await crmRequest('/api/crm/deals/assign-owner-by-phone', {
    method: 'POST',
    body: {
      phone,
      executivo_email: exec.email,
      assigned_via: 'copiloto_manual',
      assigned_by: p.solicitante ?? 'rica_ai',
    },
    operationName: 'encaminhar_assign',
  }).catch((err) => log.warn({ err }, 'assign no encaminhamento falhou (lead avisado mesmo assim)'))

  log.info({ exec: exec.name, phone: phone.slice(-4), produto }, 'Lead encaminhado manualmente')
  return `✅ Encaminhei *${nome || phone}*${produto ? ` (${produto})` : ''} pro *${exec.name}* e já avisei ele no WhatsApp. 👍`
}
