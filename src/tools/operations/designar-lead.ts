/**
 * src/tools/operations/designar-lead.ts
 *
 * Tool designar_lead — encaminha lead para executivo ESPECÍFICO.
 *
 * Usado quando: (a) membro da equipe pede pra direcionar um lead, ou
 * (b) o próprio lead menciona um executivo pelo nome.
 * Diferente de notificar_equipe que faz roteamento automático por produto.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { EXECUTIVES, EXECUTIVE_ALIASES, type ExecutiveKey } from '../../routing/executives.config.js'
import { crmRequest } from '../../lib/crm-client.js'
import { env } from '../../lib/env.js'
import { logger } from '../../observability/logger.js'
import { scheduleExecutiveFollowup } from '../../followup/executive-followup.js'

export function buildDesignarLeadTool(conversationPhone: string) {
  return tool({
    description:
      'Encaminha lead para um executivo ESPECÍFICO. Usar quando alguém da equipe pedir para ' +
      'direcionar um lead (ex: "manda pro André", "é pra Helen") OU quando o próprio lead ' +
      'mencionar um executivo (ex: "me indicaram o André"). ' +
      'IMPORTANTE: quem está na conversa pode ser da EQUIPE — o lead é outra pessoa (telefone informado).',
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

      // Envia WhatsApp pro executivo designado
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

      // Envia cópia pra Maria Helena (gestora) — exceto se ela for a designada
      if (executive.email !== EXECUTIVES.MARIA_HELENA.email) {
        const now = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(new Date())
        const managerMessage =
          `📊 *LEAD DESIGNADO (manual)*\n\n` +
          `👤 *Lead:* ${nome_lead || 'Não informado'}\n` +
          `🎯 *Interesse:* ${produto || 'Não informado'}\n` +
          `📱 *Tel:* ${telefone_lead}\n\n` +
          `➡️ *Direcionado para:* ${executive.name}\n` +
          `📋 *Motivo:* Designação manual pela equipe\n\n` +
          `⏰ ${now}`
        try {
          await fetch(`${env.UAZAPI_BASE_URL}/send/text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', token: env.UAZAPI_TOKEN },
            body: JSON.stringify({
              number: EXECUTIVES.MARIA_HELENA.phoneFormatted,
              text: managerMessage,
              delay: '3000',
            }),
            signal: AbortSignal.timeout(8_000),
          })
        } catch (err) {
          log.warn({ err }, 'Falha ao enviar cópia gestora')
        }
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

      // Agenda cobrança de status ao executivo (14h depois, horário comercial)
      try {
        await scheduleExecutiveFollowup({
          executivePhone: executive.phoneFormatted,
          executiveName: executive.name,
          leadName: nome_lead,
          leadPhone: telefone_lead,
          product: produto ?? '',
          dealId: deal_id,
          forwardedAt: new Date().toISOString(),
          assignedVia: 'designar_lead',
        })
      } catch (err) {
        log.warn({ err }, 'Falha ao agendar cobrança de status — continuando')
      }

      return { success: true, executive: executive.name, message: `Designado para ${executive.name}` }
    },
  })
}
