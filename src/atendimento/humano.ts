/**
 * src/atendimento/humano.ts
 *
 * Atendimento humano: alguém da equipe responde o lead pela tela de Conversas
 * do CRM, em vez de pelo WhatsApp.
 *
 * REGRA COMBINADA COM O DONO (27/08/2026): mandar mensagem pela tela É assumir a
 * conversa. A Rica silencia NAQUELE contato até alguém devolver. O pior cenário
 * para o cliente é receber duas respostas diferentes para a mesma pergunta —
 * uma do humano e outra da IA logo atrás.
 *
 * O desligamento reaproveita o mecanismo que já existia (Lidia ON/OFF em
 * `LeadsAlexy`), o mesmo que o comando "Roberta aqui!" usa pelo WhatsApp. Assim
 * o webhook e a régua de follow-up já respeitam o takeover sem mudança nenhuma:
 * ambos consultam esse estado antes de agir.
 */

import type { Pool } from 'pg'
import { logger } from '../observability/logger.js'
import { sendWhatsApp, sendWhatsAppMedia, type TipoDeMidia } from '../uazapi/client.js'
import { checkLidiaStatus, createLeadEntry, setLidiaStatus } from '../lidia/status.js'

/** `sender` gravado em deal_messages para a mensagem escrita por uma pessoa. */
export const SENDER_ATENDENTE = 'atendente'

export type RespostaHumana = {
  telefone: string
  texto: string
  /** Nome de quem escreveu, para o histórico. */
  atendente?: string | undefined
  dealId?: string | undefined
}

/**
 * Envia a mensagem do atendente e assume a conversa.
 *
 * A ordem importa: ENVIA primeiro, silencia depois. Se o envio falhar, a Rica
 * continua no ar — é melhor do que deixar o lead sem ninguém, com a IA
 * desligada por causa de uma mensagem que nunca chegou.
 *
 * O `crmSender` faz o `logOutbound` espelhar em `deal_messages`, então a
 * mensagem aparece sozinha na tela de Conversas, sem gravação separada aqui.
 */
export async function responderComoHumano(
  pool: Pool,
  { telefone, texto, atendente, dealId }: RespostaHumana,
): Promise<{ enviado: boolean; iaDesligada: boolean }> {
  const log = logger.child({ phone: telefone.slice(-4), context: 'atendimento-humano' })

  await sendWhatsApp(telefone, texto, {
    crmSender: SENDER_ATENDENTE,
    ...(dealId ? { dealId } : {}),
  })
  log.info({ atendente: atendente ?? '(não informado)', textoLen: texto.length }, 'atendente respondeu')

  const iaDesligada = await assumirConversa(pool, telefone)
  return { enviado: true, iaDesligada }
}

/**
 * Envia um arquivo já hospedado e assume a conversa.
 *
 * A uazapi baixa o arquivo pela URL, então ele precisa estar público ANTES
 * daqui — quem sobe para o bucket é o backend do CRM, que recebe os bytes do
 * navegador. O bot não guarda arquivo: só repassa a URL.
 */
export async function enviarMidiaComoHumano(
  pool: Pool,
  params: {
    telefone: string
    url: string
    tipo: TipoDeMidia
    legenda?: string | undefined
    nomeArquivo?: string | undefined
    atendente?: string | undefined
    dealId?: string | undefined
  },
): Promise<{ enviado: boolean; iaDesligada: boolean }> {
  const { telefone, url, tipo, legenda, nomeArquivo, atendente, dealId } = params
  const log = logger.child({ phone: telefone.slice(-4), context: 'atendimento-humano' })

  await sendWhatsAppMedia(
    telefone,
    { url, tipo, legenda, nomeArquivo },
    { crmSender: SENDER_ATENDENTE, ...(dealId ? { dealId } : {}) },
  )
  log.info({ atendente: atendente ?? '(não informado)', tipo }, 'atendente enviou mídia')

  const iaDesligada = await assumirConversa(pool, telefone)
  return { enviado: true, iaDesligada }
}

/**
 * Silencia a Rica para este telefone.
 *
 * `setLidiaStatus` faz UPDATE: se a linha não existir em `LeadsAlexy`, o update
 * não afeta nada e a IA continuaria respondendo. Por isso garantimos a linha
 * antes — `createLeadEntry` é ON CONFLICT DO NOTHING, então é seguro repetir.
 */
export async function assumirConversa(pool: Pool, telefone: string): Promise<boolean> {
  try {
    const antes = await checkLidiaStatus(pool, telefone)
    if (!antes.exists) await createLeadEntry(pool, { phone: telefone })
    await setLidiaStatus(pool, telefone, 'OFF')
    return true
  } catch (err) {
    // Não derruba o envio: a mensagem já foi para o cliente. Melhor avisar a
    // tela de que a IA continua ligada do que fingir que o takeover ocorreu.
    logger.error({ err, phone: telefone }, 'falha ao assumir conversa (IA segue ligada)')
    return false
  }
}

/** Devolve o atendimento para a Rica. */
export async function devolverParaRica(pool: Pool, telefone: string): Promise<void> {
  const estado = await checkLidiaStatus(pool, telefone)
  if (!estado.exists) await createLeadEntry(pool, { phone: telefone })
  await setLidiaStatus(pool, telefone, 'ON')
}

/**
 * Quem está atendendo agora.
 *
 * Telefone sem linha em `LeadsAlexy` conta como Rica ativa: é o que o webhook
 * faz (lead novo é criado com lidia='ON' e processado normalmente).
 */
export async function quemAtende(
  pool: Pool,
  telefone: string,
): Promise<{ ia_ativa: boolean; registro: boolean }> {
  const estado = await checkLidiaStatus(pool, telefone)
  if (!estado.exists) return { ia_ativa: true, registro: false }
  return { ia_ativa: estado.lidia === 'ON', registro: true }
}
