/**
 * src/tools/operations/definitions.ts
 *
 * Tools operacionais simples — equivalentes dos subworkflows não-CRM.
 *
 * Incluídas neste Sprint 2 (simples, sem dependências pesadas):
 *   - atualiza_nome       → atualiza nome no contato CRM + LeadsAlexy
 *   - atualiza_email      → atualiza email no contato CRM
 *   - limpar_memoria      → deleta histórico de chat (n8n_chat_histories)
 *   - consultar_projetos  → busca projetos/deals abertos do contato
 *
 * Sprint 3+: notificar_equipe, designar_lead, enviar_apresentacao, masterclass, RAG
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { Pool } from 'pg'
import { crmRequest } from '../../lib/crm-client.js'
import { clearChatHistory } from '../../memory/postgres-chat.js'
import { sendMemoryClearedMessage } from '../../uazapi/client.js'
import { logger } from '../../observability/logger.js'

/**
 * Cria tools operacionais fechadas sobre o contexto da conversa.
 */
export function buildOperationalTools(phone: string, pool: Pool) {
  const log = logger.child({ phone: phone.slice(-4), context: 'op-tool' })

  // ── atualiza_nome ───────────────────────────────────────────────────────────
  const atualiza_nome = tool({
    description:
      'Atualiza o nome do contato quando o cliente se apresenta com seu nome real. Usar sempre que o cliente confirmar ou corrigir seu nome.',
    parameters: z.object({
      contact_id: z.string().describe('UUID do contato no CRM'),
      nome: z.string().describe('Nome real do cliente'),
    }),
    execute: async ({ contact_id, nome }) => {
      log.info({ tool: 'atualiza_nome' }, 'Executando')
      try {
        await crmRequest(`/api/crm/contacts/${encodeURIComponent(contact_id)}`, {
          method: 'PATCH',
          body: { name: nome },
          operationName: 'atualiza_nome',
        })
        return { success: true, message: `Nome atualizado para ${nome}` }
      } catch (err) {
        log.warn({ err }, 'atualiza_nome: falhou no CRM')
        return { success: false, message: 'Não foi possível atualizar o nome' }
      }
    },
  })

  // ── atualiza_email ──────────────────────────────────────────────────────────
  const atualiza_email = tool({
    description:
      'Atualiza o email do contato quando o cliente informa seu email. Usar quando o cliente fornecer endereço de email.',
    parameters: z.object({
      contact_id: z.string().describe('UUID do contato no CRM'),
      email: z.string().email().describe('Endereço de email do cliente'),
    }),
    execute: async ({ contact_id, email }) => {
      log.info({ tool: 'atualiza_email' }, 'Executando')
      try {
        await crmRequest(`/api/crm/contacts/${encodeURIComponent(contact_id)}`, {
          method: 'PATCH',
          body: { email },
          operationName: 'atualiza_email',
        })
        return { success: true, message: `Email atualizado para ${email}` }
      } catch (err) {
        log.warn({ err }, 'atualiza_email: falhou')
        return { success: false, message: 'Não foi possível atualizar o email' }
      }
    },
  })

  // ── limpar_memoria ──────────────────────────────────────────────────────────
  const limpar_memoria = tool({
    description:
      'Limpa todo o histórico de conversa deste contato. Usar APENAS quando o cliente explicitamente pedir para esquecer tudo ou recomeçar do zero.',
    parameters: z.object({}),
    execute: async () => {
      log.info({ tool: 'limpar_memoria' }, 'Executando')
      await clearChatHistory(pool, phone)
      await sendMemoryClearedMessage(phone)
      return { success: true, message: 'Memória limpa' }
    },
  })

  // ── consultar_projetos ──────────────────────────────────────────────────────
  const consultar_projetos = tool({
    description:
      'Consulta os projetos/contratos ativos do cliente no CRM. Usar quando o cliente perguntar sobre andamento de projetos, contratos ou serviços contratados.',
    parameters: z.object({
      contact_id: z.string().optional().describe('UUID do contato (usa telefone da conversa se não informado)'),
    }),
    execute: async ({ contact_id }) => {
      log.info({ tool: 'consultar_projetos' }, 'Executando')
      try {
        // Busca deals por telefone — representam projetos/contratos
        const path = `/api/crm/deals/by-phone/${encodeURIComponent(phone)}`
        const data = await crmRequest(path)
        return { success: true, data }
      } catch {
        return { success: false, data: null, message: 'Não foi possível consultar projetos' }
      }
    },
  })

  return { atualiza_nome, atualiza_email, limpar_memoria, consultar_projetos }
}

export type OperationalTools = ReturnType<typeof buildOperationalTools>
