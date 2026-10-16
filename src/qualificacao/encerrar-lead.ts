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
 *
 * ONDE: na hora em que o lead fala, não a cada toque da régua (o Adonias pediu
 * para não gastar IA à toa). Um filtro por palavras decide se vale checar; só
 * então a porta do lead (IA) confirma. A régua só lê o "não contatar".
 */

import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { atualizarFunil, funilAtual, type Campanha } from '../funil/funil.js'
import { notifyHR } from '../candidato/detect.js'
import { alertarPerdido } from '../alertas/alertas.js'

/**
 * Sinal barato (sem IA) de que o lead pode estar saindo: recusa, pedido para
 * parar ou busca de emprego, em português ou espanhol. Só com ele a IA é chamada.
 * "Mais tarde" de propósito NÃO entra (adiar não é recusar).
 * 16/10: "No quiero nada" (espanhol) e "Eu não tenho padarias" passavam direto e a
 * Rica seguiu oferecendo reunião (Migdalis, 31 98435-3329).
 */
const SINAL_DE_SAIDA =
  /n[aã]o (quero|vou querer|preciso|tenho interesse)|sem interesse|desist|deixa (pra|para) (outra|depois)|outra oportunidade|n[aã]o,? obrigad|par[ae] de (me )?(mandar|enviar|ligar|chamar)|n[aã]o (me )?(mand[ae]|envi[ae]|lig[ae]|cham[ae])|me (tira|remov)|pol[ií]cia|denunc|bloque|emprego|vaga|trabalh|curr[ií]culo|ayudante|alludante|panader|empleo|oportunidad|n[aã]o vou precisar|perturb|\bno (quiero|necesito|me interesa|estoy interesad)|\bno,? gracias|no me (escrib|mand|llam|molest)|n[aã]o tenho (padaria|neg[oó]cio|empresa|loja)|no tengo (negocio|empresa)|n[aã]o sou (o |a )?(dono|dona|propriet)/i

export function temSinalDeSaida(texto: string): boolean {
  return SINAL_DE_SAIDA.test(texto)
}

/**
 * O que a Rica diz depois de encerrar o lead. Texto FIXO, sem IA: deixada solta,
 * a IA tentava salvar a venda ("posso ajudar com outras soluções") justamente com
 * quem acabou de dizer que não quer (Migdalis, 16/10).
 */
export function mensagemDeDespedida(nome?: string): string {
  const primeiro = (nome || '').trim().split(/\s+/)[0]
  const saudacao = primeiro && /^[A-Za-zÀ-ÿ]{2,}$/.test(primeiro) ? `Entendi, ${primeiro}.` : 'Entendi.'
  return `${saudacao} Obrigada pelo retorno! Não vou mais te mandar mensagens. Se um dia precisar, é só chamar por aqui. 😊`
}

/** A própria Rica combinou com o lead que não vai mais mandar mensagem (caso Solange). */
const RICA_PROMETEU_PARAR =
  /n[aã]o vou mais (te )?(enviar|mandar|incomodar|chamar)|vou respeitar (o )?seu pedido|n[aã]o (vou|irei) mais te procurar/i

export function ricaPrometeuParar(resposta: string): boolean {
  return RICA_PROMETEU_PARAR.test(resposta)
}

/** Motivo da porta do lead que indica busca de emprego. */
export function ehBuscaDeEmprego(motivo: string): boolean {
  return /emprego|vaga|trabalh|curr[ií]culo|candidat/i.test(motivo)
}

export async function encerrarComoPerdido(
  pool: Pool,
  phone: string,
  motivo: string,
  campanha: string | undefined,
  ultimaFala: string,
): Promise<void> {
  const log = logger.child({ fn: 'encerrarComoPerdido', phone: phone.slice(-4) })
  const tel = phone.replace(/\D/g, '')
  const conhecida = campanha ?? (await funilAtual(pool, phone).catch(() => null))?.campanha ?? 'outro'
  const camp = (['mentoria', 'jdl', 'gps'].includes(conhecida) ? conhecida : 'outro') as Campanha

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
