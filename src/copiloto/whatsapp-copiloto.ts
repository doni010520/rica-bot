/**
 * src/copiloto/whatsapp-copiloto.ts
 *
 * Ponte do modo COPILOTO no WhatsApp.
 *
 * Quando um MEMBRO DO TIME (telefone em users.whatsapp no CRM) manda mensagem,
 * a pergunta é encaminhada para a Rica do app (endpoint /api/rica/chat/ask, que
 * reusa o mesmo cérebro copiloto: relatórios, busca de leads, etc.) e a resposta
 * é devolvida no WhatsApp.
 *
 * É o bot reconhecendo "isso é o time" e proxiando pro cérebro copiloto — sem
 * duplicar ferramentas. Somente LEITURA na v1 (o endpoint só expõe tools de consulta).
 */

import { crmRequest } from '../lib/crm-client.js'
import { logger } from '../observability/logger.js'

type AskResponse = { is_team?: boolean; answer?: string }

/**
 * Tenta responder como copiloto. Retorna { isTeam:false } se o telefone não for
 * de um membro do time — aí o chamador segue o fluxo normal de atendimento.
 * Nunca lança: em qualquer erro, cai para atendimento (isTeam:false).
 */
export async function tryCopiloto(phone: string, message: string): Promise<{ isTeam: boolean; answer: string }> {
  try {
    const data = await crmRequest<AskResponse>('/api/rica/chat/ask', {
      method: 'POST',
      body: { phone, message },
      operationName: 'copiloto_ask',
      timeoutMs: 30_000,
    })
    return { isTeam: data.is_team === true, answer: data.answer ?? '' }
  } catch (err) {
    logger.warn({ err, phone: phone.slice(-4) }, 'Copiloto ask falhou — seguindo como atendimento')
    return { isTeam: false, answer: '' }
  }
}
