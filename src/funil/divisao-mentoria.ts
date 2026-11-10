/**
 * Divisão dos leads da Mentoria Coletiva entre executivos (nov/2026).
 *
 * Pedido da Maria Helena (09/11): a Raquel entra como executiva de vendas e os
 * leads da Mentoria passam a ser divididos MEIO A MEIO com o André, cada um
 * com a sua agenda Google. O lead fica preso ao executivo sorteado na 1ª
 * mensagem (`rica_lead_funil.executivo_email`): convite, horários, reunião e
 * ficha saem todos para a mesma pessoa.
 *
 * Alternância: o lead novo vai para quem NÃO recebeu o último lead dividido.
 * A Raquel só entra na roda com EXEC_RAQUEL_PHONE e EXEC_RAQUEL_EMAIL
 * configurados; sem isso, todo lead é do André (comportamento anterior).
 * GPS e Jornada continuam só com o André.
 */
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { EXECUTIVES, type Executive } from '../routing/executives.config.js'
import { logger } from '../observability/logger.js'

/** Quem divide a Mentoria hoje (o André sempre primeiro). */
export function executivosDaMentoria(e: { phone?: string | undefined; email?: string | undefined } = {
  phone: env.EXEC_RAQUEL_PHONE,
  email: env.EXEC_RAQUEL_EMAIL,
}): Executive[] {
  const lista: Executive[] = [EXECUTIVES.ANDRE]
  if (e.phone && e.email) {
    lista.push({ name: 'Raquel', email: e.email, phone: e.phone.replace(/^55/, ''), phoneFormatted: e.phone })
  }
  return lista
}

/** Executivo da Mentoria gravado para o lead; sem registro (ou fora da roda), o André. */
export function executivoDoLead(f: { executivo_email?: string | null } | null, lista = executivosDaMentoria()): Executive {
  const email = f?.executivo_email?.toLowerCase()
  return (email && lista.find((x) => x.email.toLowerCase() === email)) || EXECUTIVES.ANDRE
}

/** Próximo da roda: quem não recebeu o último lead dividido. */
export function proximoDaRoda(ultimoEmail: string | null | undefined, lista: Executive[]): Executive {
  if (lista.length < 2) return lista[0]!
  const i = lista.findIndex((x) => x.email.toLowerCase() === (ultimoEmail ?? '').toLowerCase())
  return lista[(i + 1) % lista.length]!
}

export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome
}

/** Grava o executivo do lead da Mentoria, se ainda não tiver. Nunca lança. */
export async function definirExecutivoMentoria(pool: Pool, phone: string): Promise<void> {
  try {
    const lista = executivosDaMentoria()
    const tel = phone.replace(/\D/g, '')
    const ultimo = await pool.query<{ executivo_email: string }>(
      `SELECT executivo_email FROM rica_lead_funil
        WHERE organization_id = $1 AND campanha = 'mentoria' AND executivo_email IS NOT NULL
        ORDER BY executivo_definido_at DESC NULLS LAST LIMIT 1`,
      [env.ORG_ID],
    )
    const exec = proximoDaRoda(ultimo.rows[0]?.executivo_email, lista)
    const r = await pool.query(
      `UPDATE rica_lead_funil SET executivo_email = $3, executivo_definido_at = NOW()
        WHERE organization_id = $1 AND phone = $2 AND campanha = 'mentoria' AND executivo_email IS NULL`,
      [env.ORG_ID, tel, exec.email],
    )
    if (r.rowCount) logger.info({ phone: tel.slice(-4), executivo: exec.name }, 'Mentoria: lead dividido')
  } catch (err) {
    logger.warn({ err }, 'divisao-mentoria: falha ao definir executivo (lead fica com o André)')
  }
}
