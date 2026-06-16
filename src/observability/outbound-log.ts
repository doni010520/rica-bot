/**
 * src/observability/outbound-log.ts
 *
 * Log PERSISTENTE de toda mensagem que a Rica envia no WhatsApp.
 * Grava em Postgres (tabela rica_mensagens_enviadas) — consultável sem
 * depender do EasyPanel / logs em memória.
 *
 * Fire-and-forget: nunca lança erro (não pode quebrar o envio da mensagem).
 */

import { getPool } from '../lib/db.js'
import { logger } from './logger.js'
import { EXECUTIVES } from '../routing/executives.config.js'

// Mapa dígitos-do-telefone → nome do executivo (para classificar o destinatário)
const EXEC_BY_DIGITS: Record<string, string> = Object.fromEntries(
  Object.values(EXECUTIVES).map((e) => [e.phoneFormatted.replace(/\D/g, ''), e.name]),
)

export function logOutbound(params: {
  toPhone: string
  content: string
  status?: 'sent' | 'error'
  error?: unknown
}): void {
  const { toPhone, content, status = 'sent', error } = params
  const digits = toPhone.replace(/\D/g, '')
  const execName = EXEC_BY_DIGITS[digits]
  const categoria = execName ? 'equipe' : 'lead'
  const erro = error ? (error instanceof Error ? error.message : String(error)) : null

  // fire-and-forget — NUNCA propaga erro
  getPool()
    .query(
      `INSERT INTO rica_mensagens_enviadas (to_phone, to_name, categoria, conteudo, status, erro)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [toPhone, execName ?? null, categoria, content, status, erro],
    )
    .catch((err) => logger.warn({ err }, 'Falha ao gravar log de mensagem enviada (rica_mensagens_enviadas)'))
}
