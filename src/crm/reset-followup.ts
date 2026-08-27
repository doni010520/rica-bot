/**
 * src/crm/reset-followup.ts
 *
 * Reseta o contador de follow-up quando o cliente responde.
 * Replica: "CRM Reset Follow-up" do n8n (HTTP POST, fire-and-forget).
 *
 * Chamado no início do handler, ANTES de processar a mensagem.
 * Não bloqueia o fluxo — falha silenciosamente com log.
 *
 * Endpoint: POST /api/crm/client-message-by-phone
 */

import { env } from '../lib/env.js'
import { crmHeaders } from '../lib/crm-client.js'
import { logger } from '../observability/logger.js'

/**
 * Reseta o follow-up counter no CRM para um telefone.
 * Fire-and-forget: não aguarda resposta, não lança erro.
 *
 * @param phone - Telefone normalizado
 */
export function resetFollowup(phone: string): void {
  // Fire-and-forget intencional — não await
  void _resetFollowup(phone)
}

async function _resetFollowup(phone: string): Promise<void> {
  try {
    const url = `${env.CRM_API_URL}/api/crm/client-message-by-phone`

    const res = await fetch(url, {
      method: 'POST',
      headers: crmHeaders(),
      body: JSON.stringify({
        phone,
        organization_id: env.ORG_ID,
      }),
      signal: AbortSignal.timeout(5000), // 5s timeout
    })

    if (!res.ok) {
      logger.warn({ phone: phone.slice(-4), status: res.status }, 'reset_followup: resposta não-ok')
    }
  } catch (err) {
    // Não crítico — loga e segue
    logger.warn({ err, phone: phone.slice(-4) }, 'reset_followup: falhou (ignorado)')
  }
}
