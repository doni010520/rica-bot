/**
 * src/tools/operations/notificar-equipe.ts
 *
 * Tool notificar_equipe — a mais crítica do sistema.
 * Replica o subworkflow de 34 nós do n8n (FdCc5kuCsjavaPXx).
 *
 * O que faz:
 *   1. Dedup Redis (bloqueia duplicatas dentro de 1h)
 *   2. Roteia para executivo via executive-router (determinístico)
 *   3. Envia WhatsApp para o executivo
 *   4. Envia cópia para Maria Helena (gestora)
 *   5. Chama assign-owner-by-phone no CRM
 *   6. Registra atividade no deal
 */

import { tool } from 'ai'
import { z } from 'zod'
import { routeToExecutive, buildExecutiveMessage, buildManagerMessage } from '../../routing/executive-router.js'
import { EXECUTIVES } from '../../routing/executives.config.js'
import { shouldNotify } from '../../dedup/redis-incr.js'
import { crmRequest } from '../../lib/crm-client.js'
import { env } from '../../lib/env.js'
import { logger } from '../../observability/logger.js'
import { nowFormatted } from '../../lib/timezone.js'

const NotificarInputSchema = z.object({
  nome: z.string().describe('Nome completo do lead'),
  telefone: z.string().describe('Telefone do lead (normalizado)'),
  produto: z.string().describe('Produto ou serviço de interesse (ex: "GPS Resultado", "Diagnóstico Empresarial para padaria")'),
  mensagem: z.string().describe('Mensagem ou contexto relevante da conversa'),
  empresa: z.string().optional().describe('Nome da empresa do lead'),
  email: z.string().optional().describe('Email do lead'),
  deal_id: z.string().optional().describe('UUID do deal no CRM'),
})

export function buildNotificarEquipeTool(conversationPhone: string) {
  return tool({
    description:
      'Notifica o executivo responsável sobre um lead qualificado. ' +
      'CHAMAR quando: cliente demonstrou interesse real, pediu proposta, pediu falar com humano, ' +
      'ou após diagnóstico empresarial completo. ' +
      'NÃO chamar para curiosos ou sem interesse claro.',
    parameters: NotificarInputSchema,
    execute: async (params) => {
      const log = logger.child({ tool: 'notificar_equipe', phone: conversationPhone.slice(-4) })
      const { nome, telefone, produto, mensagem, empresa, email, deal_id } = params

      log.info({ produto }, 'Notificar equipe chamado')

      // 1. Dedup — bloqueia duplicatas
      const canNotify = await shouldNotify(telefone, produto)
      if (!canNotify) {
        log.info({ produto }, 'Dedup: notificação bloqueada — já enviada recentemente')
        return { success: true, deduplicated: true, message: 'Já notificado recentemente' }
      }

      // 2. Roteamento determinístico
      const routing = routeToExecutive(produto, empresa ?? '', mensagem, telefone)
      const { executive, reason } = routing
      log.info({ executive: executive.name, reason }, 'Executivo selecionado')

      // 3. Envia WhatsApp para o executivo
      const execMessage = buildExecutiveMessage({
        executiveName: executive.name,
        leadName: nome,
        leadPhone: telefone,
        leadCompany: empresa ?? '',
        leadEmail: email ?? '',
        product: produto,
        message: mensagem,
        state: routing.state,
        ddd: routing.ddd,
      })

      await sendWhatsApp(executive.phoneFormatted, execMessage, log)

      // 4. Envia cópia para Maria Helena (gestora) — exceto se ela própria for a
      //    executiva escolhida (fallback), pra evitar receber 2 msgs.
      if (executive.email !== EXECUTIVES.MARIA_HELENA.email) {
        const managerMessage = buildManagerMessage({
          leadName: nome,
          product: produto,
          state: routing.state,
          ddd: routing.ddd,
          executiveName: executive.name,
          reason,
        })
        await sendWhatsApp(EXECUTIVES.MARIA_HELENA.phoneFormatted, managerMessage, log)
      }

      // 5. Atribui owner no CRM (assign-owner-by-phone)
      try {
        await crmRequest('/api/crm/deals/assign-owner-by-phone', {
          method: 'POST',
          body: {
            phone: telefone,
            executivo_email: executive.email,
            assigned_via: 'notificar_equipe',
            assigned_by: 'rica_ai',
          },
          operationName: 'assign_owner',
        })
        log.info({ email: executive.email }, 'Owner atribuído no CRM')
      } catch (err) {
        log.warn({ err }, 'Falha ao atribuir owner — continuando')
      }

      // 6. Registra atividade no deal
      if (deal_id) {
        try {
          await crmRequest(`/api/crm/deals/${encodeURIComponent(deal_id)}/activities`, {
            method: 'POST',
            body: {
              type: 'escalation',
              description: `Lead direcionado para ${executive.name} — ${reason}`,
              metadata: { executive_email: executive.email, product: produto, routing_reason: reason },
            },
            operationName: 'registrar_atividade_escalation',
          })
        } catch (err) {
          log.warn({ err }, 'Falha ao registrar atividade — continuando')
        }
      }

      log.info({ executive: executive.name }, 'Notificação enviada com sucesso')
      return {
        success: true,
        deduplicated: false,
        executive: executive.name,
        reason,
        message: `Lead direcionado para ${executive.name}`,
      }
    },
  })
}

async function sendWhatsApp(
  phone: string,
  text: string,
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
): Promise<void> {
  try {
    const res = await fetch(`${env.UAZAPI_BASE_URL}/send/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: env.UAZAPI_TOKEN },
      body: JSON.stringify({ number: phone, text, delay: '3000' }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) log.warn({ phone: phone.slice(-4), status: res.status }, 'WhatsApp send non-ok')
  } catch (err) {
    log.error({ err, phone: phone.slice(-4) }, 'Falha ao enviar WhatsApp para equipe')
  }
}
