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

/** Ação estruturada que o copiloto pode pedir ao bot pra executar (escrita). */
export type CopilotoAction = {
  type: 'encaminhar_lead'
  telefone: string
  executivo?: string
  nome?: string
  produto?: string
  empresa?: string
  solicitante?: string
}

type AskResponse = { is_team?: boolean; answer?: string; action?: CopilotoAction | null }

export type CopilotoResult = {
  isTeam: boolean
  answer: string
  action: CopilotoAction | null
  /**
   * true = a chamada ao CRM FALHOU (timeout/erro), então NÃO sabemos se é time.
   * Diferente de isTeam:false, que é o CRM afirmando "não é time".
   * Sem isso, uma queda do CRM faria um membro do time virar lead.
   */
  failed: boolean
}

export type CopilotoHistory = Array<{ role: 'user' | 'assistant'; content: string }>

/**
 * Tenta responder como copiloto. Retorna { isTeam:false } se o telefone não for
 * de um membro do time — aí o chamador segue o fluxo normal de atendimento.
 * Nunca lança: em qualquer erro, cai para atendimento (isTeam:false).
 *
 * `action` vem preenchida quando o copiloto pede uma ação de escrita (ex:
 * encaminhar um lead) — quem executa é o bot (tem o sendWhatsApp e o roteamento).
 */
export async function tryCopiloto(
  phone: string,
  message: string,
  history: CopilotoHistory = [],
): Promise<CopilotoResult> {
  try {
    const data = await crmRequest<AskResponse>('/api/rica/chat/ask', {
      method: 'POST',
      body: { phone, message, history },
      operationName: 'copiloto_ask',
      timeoutMs: 30_000,
    })
    return { isTeam: data.is_team === true, answer: data.answer ?? '', action: data.action ?? null, failed: false }
  } catch (err) {
    logger.warn({ err, phone: phone.slice(-4) }, 'Copiloto ask falhou — seguindo como atendimento')
    return { isTeam: false, answer: '', action: null, failed: true }
  }
}
