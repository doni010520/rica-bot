/**
 * src/webhook/handler.ts
 *
 * Orquestrador Sprint 2 — fluxo completo com CRM, candidato e tools.
 *
 * Fluxo buffered (após 10s):
 *   1. detectAdminCommand → REVOKE/limpar/treino/disparos ou atendimento
 *   2. preFetchCrm → busca/cria contato no CRM
 *   3. saveMessage (in)
 *   4. isJobCandidate → se true: notifyHR + return
 *   5. runRica com tools + CrmContext real
 *   6. sendWhatsAppChunked (o espelho em deal_messages sai do logOutbound)
 */

import type { Pool } from 'pg'
import { parseWebhookPayload } from '../uazapi/webhook-schema.js'
import { normalizePhone } from '../uazapi/normalize-phone.js'
import { checkLidiaStatus, createLeadEntry, setLidiaStatus, detectTakeoverCommand } from '../lidia/status.js'
import { resetFollowup } from '../crm/reset-followup.js'
import { preFetchCrm } from '../crm/pre-fetch.js'
import { saveMessage } from '../crm/save-message.js'
import { resolveMessageText } from '../media/processors.js'
import { getMessageBuffer, type BufferedMessage } from '../buffer/message-buffer.js'
import { detectAdminCommand } from '../commands/admin.js'
import { clearChatHistory, loadChatHistory, saveChatTurn, historyToMessages } from '../memory/postgres-chat.js'
import { isJobCandidate, notifyHR } from '../candidato/detect.js'
import { buildAllTools } from '../tools/index.js'
import { runRica } from '../agent/rica.js'
import { tryCopiloto } from '../copiloto/whatsapp-copiloto.js'
import { encaminharLeadManual } from '../copiloto/encaminhar.js'
import { tryApproval } from '../copiloto/aprovacoes.js'
import {
  sendWhatsApp,
  sendWhatsAppChunked,
  sendFallbackMessage,
  sendMemoryClearedMessage,
} from '../uazapi/client.js'
import { scheduleLeadFollowup, cancelLeadFollowup } from '../followup/lead-followup.js'
import { isTeamPhone } from '../routing/executives.config.js'
import { logger, webhookLogger } from '../observability/logger.js'
import { env } from '../lib/env.js'

export type WebhookHandlerDeps = { pool: Pool }

// ─── Allowlist (modo teste isolado) ──────────────────────────────────────────
// Se ALLOWED_PHONES estiver vazia → processa todos os webhooks (produção).
// Se preenchida → ignora silenciosamente mensagens fora da lista.
const ALLOWED_PHONES = env.ALLOWED_PHONES
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ALLOWLIST_ACTIVE = ALLOWED_PHONES.length > 0
if (ALLOWLIST_ACTIVE) {
  logger.warn(
    { allowed: ALLOWED_PHONES },
    '🚧 ALLOWED_PHONES configurado — modo teste isolado ativo',
  )
}

// ─── handler de entrada (rápido — só enfileira) ───────────────────────────────

export async function handleWebhook(rawBody: unknown, deps: WebhookHandlerDeps): Promise<void> {
  const parsed = parseWebhookPayload(rawBody)
  if (!parsed) {
    // DEBUG: loga o payload bruto pra diagnosticar formato do uazapi
    logger.warn({ rawBody }, 'Webhook: payload inválido — ignorando')
    return
  }

  const phone = normalizePhone(parsed.phone)
  const log = webhookLogger(phone, parsed.messageId)

  // Allowlist: ignora silenciosamente quem não está na lista (modo teste)
  if (ALLOWLIST_ACTIVE && !ALLOWED_PHONES.includes(phone)) {
    log.debug({ phone: phone.slice(-4) }, 'ignored_by_allowlist')
    return
  }

  // Eco da própria API (rica-bot enviou e uazapi devolveu) — ignora silenciosamente
  if (parsed.wasSentByApi) {
    log.debug('ignored_was_sent_by_api')
    return
  }

  // fromMe sem wasSentByApi → operador humano digitou no WhatsApp
  if (parsed.fromMe) {
    await handleFromMe(phone, parsed.text ?? '', deps.pool, log)
    return
  }

  resetFollowup(phone)
  // Lead falou → cancela qualquer toque de follow-up pendente (será reagendado
  // no toque 1 depois que a Rica responder).
  void cancelLeadFollowup(phone)

  const lidiaResult = await checkLidiaStatus(deps.pool, phone)
  if (!lidiaResult.exists) {
    // Time NUNCA vira lead na LeadsAlexy (ver isTeamPhone).
    if (!isTeamPhone(phone)) {
      await createLeadEntry(deps.pool, { phone, name: parsed.displayName })
    }
  } else if (lidiaResult.lidia === 'OFF') {
    log.info('lidia_off — skip')
    return
  }

  let messageText: string
  try {
    messageText = await resolveMessageText(parsed)
  } catch (err) {
    log.error({ err, mediaType: parsed.mediaType }, 'Falha ao processar mídia')
    messageText = parsed.text ?? '[Mensagem recebida]'
  }

  if (!messageText.trim()) return

  // Detecta comando admin ANTES do buffer (REVOKE e LimparDados são síncronos)
  const rawText = parsed.text ?? messageText
  const cmd = detectAdminCommand(rawText, parsed.isRevoke)

  if (cmd === 'revoke') {
    log.debug('REVOKE — ignorando')
    return
  }

  if (cmd === 'limpar') {
    await clearChatHistory(deps.pool, phone)
    await sendMemoryClearedMessage(phone)
    log.info('Memória limpa por LimparDados')
    return
  }

  if (cmd === 'treino' || cmd === 'disparos') {
    log.info({ cmd }, 'Comando admin — Sprint 5+')
    return
  }

  // Fluxo normal: enfileira no buffer
  await getMessageBuffer().push(phone, messageText)
  log.debug({ mediaType: parsed.mediaType }, 'Mensagem no buffer')
}

// ─── handler do worker (fluxo completo) ──────────────────────────────────────

export async function handleBufferedMessage(
  msg: BufferedMessage,
  deps: WebhookHandlerDeps,
): Promise<void> {
  const { phone, combinedText } = msg
  const log = webhookLogger(phone)

  log.info({ messageCount: msg.messageCount }, 'Processando buffer')

  // 0. APROVAÇÃO: se a gestora aprovou uma sugestão da Rica, encaminha pro dev.
  if (await tryApproval(deps.pool, phone, combinedText)) {
    log.info('Aprovação da gestora processada')
    return
  }

  // 0.1 COPILOTO: se o telefone for de um membro do time, responde com dados do
  //     CRM (relatórios, leads) em vez de tratar como lead. Senão, segue normal.
  //     Memória curta: passa o histórico recente pro copiloto (ex: lead numa msg,
  //     "envia pro André" na próxima) e persiste o turno depois.
  const copiHistory = historyToMessages(await loadChatHistory(deps.pool, phone, 12).catch(() => []))
  const copi = await tryCopiloto(phone, combinedText, copiHistory)
  if (copi.isTeam) {
    let resposta: string
    if (copi.action?.type === 'encaminhar_lead') {
      // Ação de escrita (encaminhar lead): o bot executa (tem o sendWhatsApp e o roteamento).
      resposta = await encaminharLeadManual(copi.action)
      log.info({ exec: copi.action.executivo }, 'Copiloto encaminhou lead (ação)')
    } else {
      resposta = copi.answer || 'Não consegui responder agora 😕'
      log.info('Copiloto respondeu (membro do time)')
    }
    // crmSender: null — o copiloto atende o TIME, não é conversa de lead.
    await sendWhatsAppChunked(phone, resposta, { crmSender: null })
    await saveChatTurn(deps.pool, phone, combinedText, resposta).catch(() => {})
    return
  }

  // 0.2 REDE DE SEGURANÇA: chegou aqui = o copiloto NÃO atendeu. Se o telefone é
  //     do time, NUNCA tratar como lead (não cria deal, não vende, não agenda
  //     follow-up — a Rica ficaria cobrando o próprio time).
  if (isTeamPhone(phone)) {
    if (copi.failed) {
      // O CRM caiu: não sabemos nada. Avisar é melhor que silenciar — a pessoa
      // (ex: Malu encaminhando um lead) precisa saber que deve tentar de novo.
      log.error({ phone: phone.slice(-4) }, '⚠️ Copiloto indisponível para membro do time — avisando, NÃO tratado como lead')
      await sendWhatsApp(
        phone,
        'Oi! Tive um problema aqui no sistema e não consegui processar sua mensagem agora 😕 Pode mandar de novo daqui a pouquinho?',
        { crmSender: null },
      ).catch(() => {})
    } else {
      // O CRM afirmou "não é time" → falta cadastrar o whatsapp em users.whatsapp.
      log.warn(
        { phone: phone.slice(-4) },
        '⚠️ Membro do time não reconhecido pelo copiloto (falta users.whatsapp no CRM) — ignorando, NÃO tratado como lead',
      )
    }
    return
  }

  // 1. Pre-fetch CRM (Pre_BuscarContato / Pre_RegistrarLead)
  //    Passa a 1a mensagem para detectar o funil (ex: GPS nasce no funil GPS)
  const crm = await preFetchCrm(phone, '', combinedText)

  // 2. Salvar mensagem do cliente (direction=in) — fire-and-forget
  saveMessage({
    phone,
    direction: 'in',
    text: combinedText,
    sender: 'cliente',
    dealId: crm.dealId,
  })

  // 3. Detecta candidato (IF_Candidato) — ANTES do agent
  if (isJobCandidate(combinedText)) {
    log.info('Candidato detectado — notificando RH')
    await notifyHR({
      candidatePhone: phone,
      candidateName: crm.contactName ?? '',
      candidateMessage: combinedText,
      dealId: crm.dealId,
    })
    return // Rica não responde para candidatos
  }

  // 4. Executa agent com tools e CrmContext real
  const tools = buildAllTools(phone, deps.pool)
  const result = await runRica({ phone, displayName: crm.contactName ?? '', userMessage: combinedText, crm, tools }, deps.pool)

  if (result.usedFallback || !result.text) {
    await sendFallbackMessage(phone, crm.dealId)
    log.warn('Fallback enviado')
    return
  }

  // 5. Envia em chunks com delay. NÃO chamar saveMessage aqui: o logOutbound
  //    (dentro do sendWhatsAppChunked) já espelha a resposta em deal_messages —
  //    salvar de novo duplicaria a mensagem no thread do CRM.
  await sendWhatsAppChunked(phone, result.text, {
    crmSender: 'rica_ai',
    dealId: crm.dealId,
  })
  log.info({ chunks: result.text.split('\n\n').filter(Boolean).length }, 'Resposta enviada')

  // 6. Agenda follow-up inteligente (toque 1). Cancelado se o lead responder.
  void scheduleLeadFollowup(phone, 1)
}

// ─── fromMe handler ───────────────────────────────────────────────────────────

async function handleFromMe(
  phone: string,
  text: string,
  pool: Pool,
  log: ReturnType<typeof webhookLogger>,
): Promise<void> {
  const newStatus = detectTakeoverCommand(text)
  if (newStatus) {
    await setLidiaStatus(pool, phone, newStatus)
    log.info({ newStatus }, 'Takeover detectado')
  }
}
