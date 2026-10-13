/**
 * src/qualificacao/encerrar-lead.ts
 *
 * Encerra como PERDIDO quem não é (mais) lead, antes de qualquer toque da régua.
 *
 * POR QUE: sair da régua dependia de a Rica chamar a tool nao_contatar, e ela
 * nem sempre chama. Em out/2026 a Rica respondeu "vou respeitar seu pedido e não
 * vou mais te enviar mensagens" e mesmo assim o follow-up saiu no dia seguinte
 * (Solange, 38 9943-3697, que ameaçou ir à polícia); a Clenilda, 82 anos ("não
 * quero nada contigo"), recebeu 4 toques. Quem pedia vaga de padeiro também
 * seguia na régua. A Jéssica pediu (13/10): parar, marcar como perdido e, para
 * quem procura emprego, mandar o e-mail do RH.
 */

import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { atualizarFunil, type Campanha } from '../funil/funil.js'
import { notifyHR } from '../candidato/detect.js'
import { alertarPerdido } from '../alertas/alertas.js'

/** Motivo da porta do lead que indica busca de emprego. */
export function ehBuscaDeEmprego(motivo: string): boolean {
  return /emprego|vaga|trabalh|curr[ií]culo|candidat/i.test(motivo)
}

export async function encerrarComoPerdido(
  pool: Pool,
  phone: string,
  motivo: string,
  campanha: string,
  ultimaFala: string,
): Promise<void> {
  const log = logger.child({ fn: 'encerrarComoPerdido', phone: phone.slice(-4) })
  const tel = phone.replace(/\D/g, '')
  const camp = (['mentoria', 'jdl', 'gps'].includes(campanha) ? campanha : 'outro') as Campanha

  await atualizarFunil(pool, phone, camp, { etapa: 'nao_contatar', evento: 'perdido_auto', dados: { motivo } })
  await pool.query(
    `UPDATE rica_lead_funil SET nao_contatar = true WHERE organization_id = $1 AND phone = $2`,
    [env.ORG_ID, tel],
  ).catch(() => {})
  await pool.query(
    `UPDATE rica_resgate SET encerrado = true WHERE organization_id = $1 AND phone = $2`,
    [env.ORG_ID, tel],
  ).catch(() => {})
  const perdido = await pool.query(
    `UPDATE deals SET status = 'lost', lost_date = now(), closed_at = now(), updated_at = now(),
            lost_reason = $3
      WHERE organization_id = $1 AND status = 'open'
        AND right(regexp_replace(contact_phone, '\\D', '', 'g'), 8) = right($2, 8)
      RETURNING id`,
    [env.ORG_ID, tel, `Encerrado pela Rica: ${motivo}`.slice(0, 250)],
  ).catch((err) => { log.warn({ err }, 'Não marcou o deal como perdido'); return { rowCount: 0 } })

  if (ehBuscaDeEmprego(motivo)) {
    // Mesmo caminho do candidato detectado na hora: e-mail do RH uma vez (7 dias) + aviso à Vanessa.
    await notifyHR({ candidatePhone: tel, candidateName: '', candidateMessage: ultimaFala }).catch(() => false)
  }

  void alertarPerdido(tel, motivo)
  log.info({ motivo, dealsPerdidos: perdido.rowCount }, '🛑 Lead encerrado como perdido antes do follow-up')
}
