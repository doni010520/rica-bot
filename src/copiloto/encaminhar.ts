/**
 * src/copiloto/encaminhar.ts
 *
 * Encaminhamento MANUAL de lead pelo copiloto (membro do time: "envia pro André").
 *
 * É só a "casca" do canal copiloto: chama o NÚCLEO ÚNICO (routing/encaminhar-lead)
 * — o mesmo que o agente de atendimento usa via designar_lead — e formata a
 * confirmação como mensagem de WhatsApp pra quem pediu.
 */

import { normalizePhone } from '../uazapi/normalize-phone.js'
import { encaminharLead } from '../routing/encaminhar-lead.js'

export type EncaminharParams = {
  telefone: string
  nome?: string
  produto?: string
  empresa?: string
  /** Nome do executivo de destino. Se vazio, roteia por produto/região. */
  executivo?: string
  /** Quem pediu o encaminhamento (membro do time). */
  solicitante?: string
}

export async function encaminharLeadManual(p: EncaminharParams): Promise<string> {
  const r = await encaminharLead({
    telefone: p.telefone,
    nome: p.nome,
    produto: p.produto,
    empresa: p.empresa,
    executivo: p.executivo,
    solicitante: p.solicitante,
  })

  if (!r.success) return `❌ ${r.errorMessage}`

  const quem = (p.nome ?? '').trim() || normalizePhone(p.telefone ?? '')
  const prod = (p.produto ?? '').trim()
  return `✅ Encaminhei *${quem}*${prod ? ` (${prod})` : ''} pro *${r.executiveName}* e já avisei ele no WhatsApp. 👍`
}
