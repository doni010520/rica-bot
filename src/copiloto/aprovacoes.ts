/**
 * src/copiloto/aprovacoes.ts
 *
 * Loop de autoaperfeiçoamento: a Rica sugere mudanças no próprio atendimento
 * (nos relatórios diário/semanal pra gestora). Quando a GESTORA aprova
 * respondendo no WhatsApp ("aprovo ..."), o bot encaminha a aprovação pro
 * DEV (Adonias) — com o último relatório como contexto — pra ele aplicar no
 * prompt da Rica.
 */

import type { Pool } from 'pg'
import { sendWhatsApp } from '../uazapi/client.js'
import { EXECUTIVES } from '../routing/executives.config.js'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'

const APROVA_RE = /\baprov(o|ar|ado|ada|amos|ada)\b/i

const last8 = (p: string) => p.replace(/\D/g, '').slice(-8)

function isGestora(phone: string): boolean {
  return last8(phone) === last8(EXECUTIVES.MARIA_HELENA.phoneFormatted)
}

/**
 * Se a gestora aprovou uma sugestão, encaminha pro dev e responde a ela.
 * Retorna true se tratou (o chamador deve parar o fluxo normal).
 */
export async function tryApproval(pool: Pool, phone: string, message: string): Promise<boolean> {
  if (!isGestora(phone)) return false
  if (!APROVA_RE.test(message)) return false

  const log = logger.child({ fn: 'tryApproval' })

  // Último relatório enviado à gestora (dá contexto pro dev saber a qual sugestão se refere)
  let contexto = ''
  try {
    const r = await pool.query(
      `SELECT conteudo FROM rica_mensagens_enviadas
       WHERE to_phone = $1 AND (conteudo ILIKE '%Resumo do dia%' OR conteudo ILIKE '%Análise da semana%')
       ORDER BY created_at DESC LIMIT 1`,
      [EXECUTIVES.MARIA_HELENA.phoneFormatted],
    )
    contexto = r.rows[0]?.conteudo ?? ''
  } catch (err) {
    log.warn({ err }, 'Falha ao buscar relatório de contexto da aprovação')
  }

  const devMsg =
    `✅ *Maria Helena aprovou uma mudança no atendimento da Rica*\n\n` +
    `📝 *O que ela respondeu:*\n${message}\n\n` +
    (contexto ? `📊 *Último relatório (contexto):*\n${contexto.slice(0, 1200)}\n\n` : '') +
    `_Me repassa essa aprovação que eu aplico no prompt da Rica._`

  try {
    await sendWhatsApp(env.APPROVAL_FORWARD_PHONE, devMsg, { crmSender: null })
  } catch (err) {
    log.error({ err }, 'Falha ao encaminhar aprovação ao dev')
  }
  try {
    await sendWhatsApp(
      EXECUTIVES.MARIA_HELENA.phoneFormatted,
      'Anotado! 🙌 Já encaminhei sua aprovação pro Adonias aplicar essa mudança no meu atendimento.',
      { crmSender: null },
    )
  } catch (err) {
    log.warn({ err }, 'Falha ao confirmar à gestora')
  }

  log.info('Aprovação da gestora encaminhada ao dev')
  return true
}
