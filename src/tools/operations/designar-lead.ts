/**
 * src/tools/operations/designar-lead.ts
 *
 * Tool designar_lead — designa lead para executivo ESPECÍFICO mencionado pelo cliente.
 * Replica o subworkflow de 16 nós do n8n (IvDqiFrUig0OHBbw).
 *
 * Diferente de notificar_equipe (automático): aqui o cliente ou a Rica identificou
 * explicitamente o nome de um executivo ("quero falar com a Helen", "me indicaram o André").
 */

import { tool } from 'ai'
import { z } from 'zod'
import { EXECUTIVES, EXECUTIVE_ALIASES, type ExecutiveKey } from '../../routing/executives.config.js'
import { crmRequest } from '../../lib/crm-client.js'
import { env } from '../../lib/env.js'
import { logger } from '../../observability/logger.js'

export function buildDesignarLeadTool(conversationPhone: string) {
  return tool({
    description:
      'Designa o lead para um executivo ESPECÍFICO quando o cliente mencionar um nome ' +
      '(ex: "quero falar com a Helen", "me indicaram o André"). ' +
      'Usar apenas quando houver menção explícita a um executivo.',
    parameters: z.object({
      executivo_mencionado: z.string().describe('Nome do executivo mencionado (ex: "Helen", "André Augusto")'),
      nome_lead: z.string().describe('Nome do lead'),
      telefone_lead: z.string().describe('Telefone do lead'),
      produto: z.string().optional().describe('Produto de interesse'),
      mensagem: z.string().optional().describe('Contexto da conversa'),
      deal_id: z.string().optional().describe('UUID do deal'),
    }),
    execute: async ({ executivo_mencionado, nome_lead, telefone_lead, produto, mensagem, deal_id }) => {
      const log = logger.child({ tool: 'designar_lead', phone: conversationPhone.slice(-4) })

      // Resolve o executivo pelo alias
      const key = EXECUTIVE_ALIASES[executivo_mencionado.toLowerCase()]
      if (!key) {
        log.warn({ executivo_mencionado }, 'Executivo não reconhecido')
        return {
          success: false,
          message: `Executivo "${executivo_mencionado}" não encontrado. Executivos disponíveis: ${Object.keys(EXECUTIVES).join(', ')}`,
        }
      }

      const executive = EXECUTIVES[key as ExecutiveKey]
      log.info({ executive: executive.name }, 'Designando lead')

      // Monta mensagem para o executivo
      const firstName = executive.name.split(' ')[0] ?? executive.name
      const phoneForLink = telefone_lead.replace(/^55/, '')

      const message =
        `🎯 *LEAD DESIGNADO PRA VOCÊ, ${firstName.toUpperCase()}!*\n\n` +
        `Oi ${firstName}! 👋 Aqui é a Rica 🤖\n\n` +
        `A equipe direcionou esse lead especificamente pra você:\n\n` +
        `━━━━━━━━━━━━━━\n📋 *DADOS DO LEAD*\n━━━━━━━━━━━━━━\n\n` +
        `👤 *Nome:* ${nome_lead || 'Não informado'}\n` +
        `📱 *Tel:* ${telefone_lead}\n` +
        `🎯 *Interesse:* ${produto || 'Não informado'}\n\n` +
        `━━━━━━━━━━━━━━\n💬 *CONTEXTO*\n━━━━━━━━━━━━━━\n` +
        `_"${mensagem || 'Sem observações adicionais'}"_\n\n` +
        `⚡ *Clique para chamar no WhatsApp:*\nwa.me/${phoneForLink}\n\n` +
        `🤖 _Rica - Assistente de Vendas_`

      // Envia WhatsApp
      try {
        await fetch(`${env.UAZAPI_BASE_URL}/send/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', token: env.UAZAPI_TOKEN },
          body: JSON.stringify({ number: executive.phoneFormatted, text: message, delay: '3000' }),
          signal: AbortSignal.timeout(8_000),
        })
      } catch (err) {
        log.error({ err }, 'Falha ao enviar WhatsApp para executivo')
      }

      // Atribui owner no CRM
      try {
        await crmRequest('/api/crm/deals/assign-owner-by-phone', {
          method: 'POST',
          body: {
            phone: telefone_lead,
            executivo_email: executive.email,
            assigned_via: 'designar_lead',
            assigned_by: 'rica_ai',
          },
        })
      } catch (err) {
        log.warn({ err }, 'Falha ao atribuir owner')
      }

      // Registra atividade
      if (deal_id) {
        try {
          await crmRequest(`/api/crm/deals/${encodeURIComponent(deal_id)}/activities`, {
            method: 'POST',
            body: {
              type: 'escalation',
              description: `Lead designado especificamente para ${executive.name}`,
              metadata: { assigned_to: executive.email, reason: 'cliente_solicitou' },
            },
          })
        } catch { /* ignora */ }
      }

      return { success: true, executive: executive.name, message: `Designado para ${executive.name}` }
    },
  })
}
