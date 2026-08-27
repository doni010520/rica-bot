/**
 * src/crm/save-message.ts
 *
 * Persiste mensagens no histórico deal_messages.
 * Replica: "Salvar msg cliente" + "Salvar resposta Rica" do n8n.
 *
 * Endpoint: POST /api/crm/messages
 * Tabela: deal_messages (criada no PR #10 / migration 010_deal_messages.sql)
 */

import { env } from '../lib/env.js'
import { crmHeaders } from '../lib/crm-client.js'
import { logger } from '../observability/logger.js'

type MessageDirection = 'in' | 'out'
type ContentType = 'text' | 'image' | 'audio' | 'document' | 'system_note'

type SaveMessageParams = {
  phone: string
  direction: MessageDirection
  text: string
  sender: string          // 'cliente' | 'rica_ai' | 'system_followup'
  contentType?: ContentType | undefined
  dealId?: string | undefined
}

/**
 * Grava mensagem no deal_messages. Fire-and-forget — não bloqueia o fluxo.
 */
export function saveMessage(params: SaveMessageParams): void {
  void _saveMessage(params)
}

async function _saveMessage(params: SaveMessageParams): Promise<void> {
  const { phone, direction, text, sender, contentType = 'text', dealId } = params

  try {
    const url = `${env.CRM_API_URL}/api/crm/messages?organization_id=${env.ORG_ID}`
    const body = {
      phone,
      direction,
      text,
      sender,
      content_type: contentType,
      deal_id: dealId,
      workflow_name: 'rica-bot',
      sent_at: new Date().toISOString(),
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: crmHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    })

    if (!res.ok) {
      logger.warn({ phone: phone.slice(-4), direction, status: res.status }, 'save_message: não-ok')
    }
  } catch (err) {
    logger.warn({ err, phone: phone.slice(-4), direction }, 'save_message: falhou (ignorado)')
  }
}
