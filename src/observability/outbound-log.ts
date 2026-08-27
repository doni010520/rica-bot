/**
 * src/observability/outbound-log.ts
 *
 * Log PERSISTENTE de toda mensagem que a Rica envia no WhatsApp.
 * Grava em Postgres (tabela rica_mensagens_enviadas) — consultável sem
 * depender do EasyPanel / logs em memória.
 *
 * PONTO ÚNICO de classificação do destinatário (lead × equipe). Quando é LEAD,
 * espelha a mensagem em deal_messages (saveMessage) — é assim que o CRM exibe o
 * thread da conversa SEM buracos: todo caminho que envia ao lead passa por aqui,
 * inclusive os follow-ups, o fallback de erro e a resposta a candidato.
 *
 * Fire-and-forget: nunca lança erro (não pode quebrar o envio da mensagem).
 */

import { getPool } from '../lib/db.js'
import { logger } from './logger.js'
import { EXECUTIVES, isTeamPhone } from '../routing/executives.config.js'
import { saveMessage } from '../crm/save-message.js'

// Mapa dígitos-do-telefone → nome do executivo (só para preencher to_name)
const EXEC_BY_DIGITS: Record<string, string> = Object.fromEntries(
  Object.values(EXECUTIVES).map((e) => [e.phoneFormatted.replace(/\D/g, ''), e.name]),
)

/** Metadados do espelhamento em deal_messages (CRM). */
export type OutboundCrmMeta = {
  /**
   * `sender` semântico esperado pelo CRM ('rica_ai', 'system_followup', ...).
   * `null` = NÃO espelhar em deal_messages (ex: resposta ao time via copiloto,
   * que o CRM reconhece mas o isTeamPhone daqui pode não cobrir).
   */
  crmSender?: string | null | undefined
  /** Deal ao qual a mensagem pertence, quando conhecido. */
  dealId?: string | undefined
}

export function logOutbound(params: {
  toPhone: string
  content: string
  status?: 'sent' | 'error'
  error?: unknown
  /** Preenchidos quando a mensagem é mídia — ver sendWhatsAppMedia. */
  mediaUrl?: string | undefined
  mediaType?: 'image' | 'audio' | 'video' | 'ptt' | 'document' | undefined
} & OutboundCrmMeta): void {
  const { toPhone, content, status = 'sent', error, crmSender = 'rica_ai', dealId, mediaUrl, mediaType } = params
  const digits = toPhone.replace(/\D/g, '')
  const execName = EXEC_BY_DIGITS[digits]
  // isTeamPhone cobre EXECUTIVES + TEAM_PHONES (triagem/gestão/dev) e tolera o
  // 9º dígito — classificação mais confiável que comparar só com os executivos.
  const categoria = isTeamPhone(toPhone) ? 'equipe' : 'lead'
  const erro = error ? (error instanceof Error ? error.message : String(error)) : null

  // Espelha no thread do CRM: só LEAD, só o que realmente saiu.
  if (categoria === 'lead' && status === 'sent' && crmSender) {
    saveMessage({
      phone: toPhone,
      direction: 'out',
      text: content,
      sender: crmSender,
      dealId,
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(mediaType ? { mediaType } : {}),
    })
  }

  // fire-and-forget — NUNCA propaga erro
  getPool()
    .query(
      `INSERT INTO rica_mensagens_enviadas (to_phone, to_name, categoria, conteudo, status, erro)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [toPhone, execName ?? null, categoria, content, status, erro],
    )
    .catch((err) => logger.warn({ err }, 'Falha ao gravar log de mensagem enviada (rica_mensagens_enviadas)'))
}
