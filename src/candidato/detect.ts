/**
 * src/candidato/detect.ts
 *
 * Detecção de candidatos e notificação do RH.
 * Replica: IF_Candidato + Notificar_Vannessa do n8n.
 *
 * CONTEXTO (investigado em 26/mai/2026):
 * IF_Candidato é regex case-insensitive sobre o texto da mensagem.
 * Quando match → notifica Vanessa (RH) e INTERROMPE o fluxo (Rica não responde).
 *
 * Regex extraída diretamente do n8n:
 *   vaga|emprego|curr[ií]culo|candidat|sele[cç][aã]o|trainee|
 *   est[aá]gio|trabalhar|contratar|processo.seletivo|
 *   oportunidade.de.trabalho|rh\b|recursos.humanos
 *
 * POSIÇÃO NO FLUXO: após pre-fetch (contato já identificado), antes do agent.
 */

import { env } from '../lib/env.js'
import { normalizePhone } from '../uazapi/normalize-phone.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { logger } from '../observability/logger.js'

// ─── regex (fonte de verdade: extraída do IF_Candidato do n8n) ────────────────
// Nota: .seletivo e .de.trabalho usam [ .] em vez de . para explicitar intenção
// caseSensitive: false no n8n → /i em JS

const CANDIDATE_REGEX =
  /vaga|emprego|curr[ií]culo|candidat|sele[cç][aã]o|trainee|est[aá]gio|trabalhar|contratar|processo[ .]seletivo|oportunidade[ .]de[ .]trabalho|\brh\b|recursos[ .]humanos/i

/**
 * Verifica se a mensagem indica que o remetente é um candidato a emprego.
 * Replica: IF_Candidato do n8n.
 */
export function isJobCandidate(message: string): boolean {
  return CANDIDATE_REGEX.test(message)
}

/**
 * Notifica Vanessa (RH) sobre candidato detectado e orienta o candidato.
 * Replica: Notificar_Vannessa do n8n.
 *
 * Ações:
 * 1. Envia WhatsApp para Vanessa com nome/telefone/mensagem do candidato
 * 2. Responde ao candidato orientando a enviar currículo por email
 *
 * Os dois envios passam pelo sendWhatsApp para cair no logOutbound: o aviso ao
 * RH é EQUIPE (não vai pro thread), enquanto a resposta ao candidato é a única
 * mensagem que ele recebe — sem ela o CRM mostraria a pergunta dele sem réplica.
 *
 * @returns true se notificação foi enviada com sucesso
 */
export async function notifyHR(params: {
  candidatePhone: string
  candidateName: string
  candidateMessage: string
  dealId?: string | undefined
}): Promise<boolean> {
  const { candidatePhone, candidateName, candidateMessage, dealId } = params
  const log = logger.child({ fn: 'notifyHR', candidatePhone: candidatePhone.slice(-4) })

  const hrPhone = normalizePhone(env.HR_NOTIFY_PHONE)

  // Mensagem para Vanessa
  const hrMessage =
    `🔔 *Novo candidato detectado*\n\n` +
    `👤 *Nome:* ${candidateName || 'Não informado'}\n` +
    `📱 *Telefone:* ${candidatePhone}\n\n` +
    `💬 *Mensagem:*\n${candidateMessage}`

  // Mensagem de orientação para o candidato
  const candidateReply =
    `Olá ${candidateName ? candidateName.split(' ')[0] : ''}! 😊\n\n` +
    `Percebi que você tem interesse em fazer parte da nossa equipe!\n\n` +
    `Para dar continuidade ao processo seletivo, por favor envie seu currículo para:\n` +
    `📧 *${env.HR_EMAIL}*\n\n` +
    `Nossa equipe de RH entrará em contato em breve. Boa sorte! 🍀`

  try {
    // Aviso ao RH: destinatário é do time — crmSender null garante que não entra
    // no thread do lead nem se HR_NOTIFY_PHONE ficar fora de TEAM_PHONES.
    await sendWhatsApp(hrPhone, hrMessage, { crmSender: null })

    // Responde ao candidato — entra no thread como resposta da Rica.
    await sendWhatsApp(normalizePhone(candidatePhone), candidateReply, {
      crmSender: 'system_candidato',
      dealId,
    })

    log.info('Candidato notificado — HR e candidato informados')
    return true
  } catch (err) {
    log.error({ err }, 'Falha ao notificar RH sobre candidato')
    return false
  }
}
