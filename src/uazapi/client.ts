/**
 * src/uazapi/client.ts
 *
 * Cliente uazapi para envio de mensagens WhatsApp.
 *
 * Payload correto (confirmado no n8n workflow 56f4gE0UKHEXMUfa):
 *   { "number": "...", "text": "...", "delay": "3000" }
 *   NÃO é { "phone": ..., "message": ... }
 */

import { env } from '../lib/env.js'
import { sleep } from '../lib/timezone.js'
import { formatPhoneForSend } from './normalize-phone.js'
import { withRetry } from '../lib/retry.js'
import { logger } from '../observability/logger.js'
import { logOutbound, type OutboundCrmMeta } from '../observability/outbound-log.js'

// Payload exato que a uazapi aceita (confirmado nos nós "enviar mensagem*" do n8n)
type UazapiSendPayload = {
  number: string
  text: string
  delay?: string
}

/** Tipos que a uazapi aceita em /send/media. */
export type TipoDeMidia = 'image' | 'audio' | 'video' | 'document' | 'ptt'

type UazapiMediaPayload = {
  number: string
  type: TipoDeMidia
  /** A uazapi NÃO recebe o arquivo: recebe uma URL e baixa de lá. */
  file: string
  text?: string
  docName?: string
}

type SendOptions = OutboundCrmMeta & {
  chunkDelayMs?: number | undefined
  chunked?: boolean | undefined
}

export type { OutboundCrmMeta }

async function postToUazapi(
  body: UazapiSendPayload | UazapiMediaPayload,
  caminho = '/send/text',
): Promise<void> {
  const url = `${env.UAZAPI_BASE_URL}${caminho}`

  await withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: env.UAZAPI_TOKEN },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw Object.assign(new Error(`uazapi ${res.status}: ${txt}`), { status: res.status })
      }
    },
    {
      attempts: 3,
      operationName: 'uazapi_send',
      isRetryable: (err) => {
        if (err instanceof Error && 'status' in err) {
          const s = (err as { status: number }).status
          return s === 429 || s >= 500
        }
        return true
      },
    },
  )
}

export async function sendWhatsApp(
  phone: string,
  text: string,
  meta: OutboundCrmMeta = {},
): Promise<void> {
  const number = formatPhoneForSend(phone)
  logger.debug({ phone: number.slice(-4), textLen: text.length }, 'sendWhatsApp')
  let error: unknown
  try {
    await postToUazapi({ number, text, delay: '3000' })
  } catch (e) {
    error = e
  }
  logOutbound({
    toPhone: number,
    content: text,
    status: error ? 'error' : 'sent',
    error,
    crmSender: meta.crmSender,
    dealId: meta.dealId,
  })
  if (error) throw error
}

/**
 * Envia mídia (imagem, áudio, vídeo ou documento) pelo WhatsApp.
 *
 * A uazapi NÃO recebe bytes: recebe uma URL e baixa o arquivo de lá. Por isso o
 * arquivo precisa estar num lugar público ANTES desta chamada — hoje o bucket
 * `media` do Supabase Storage.
 *
 * `ptt` é a mensagem de voz (a "bolinha" de áudio gravado); `audio` é arquivo de
 * áudio anexado. Quem grava pelo microfone quer ptt.
 */
export async function sendWhatsAppMedia(
  phone: string,
  params: { url: string; tipo: TipoDeMidia; legenda?: string | undefined; nomeArquivo?: string | undefined },
  meta: OutboundCrmMeta = {},
): Promise<void> {
  const number = formatPhoneForSend(phone)
  const { url, tipo, legenda, nomeArquivo } = params
  logger.debug({ phone: number.slice(-4), tipo }, 'sendWhatsAppMedia')

  let error: unknown
  try {
    await postToUazapi(
      {
        number,
        type: tipo,
        file: url,
        ...(legenda ? { text: legenda } : {}),
        // Sem docName o cliente vê o nome gerado no storage em vez do original.
        ...(tipo === 'document' && nomeArquivo ? { docName: nomeArquivo } : {}),
      },
      '/send/media',
    )
  } catch (e) {
    error = e
  }

  logOutbound({
    toPhone: number,
    // O histórico precisa de texto: uma bolha vazia não diz nada a quem lê depois.
    content: legenda || nomeArquivo || rotuloDaMidia(tipo),
    status: error ? 'error' : 'sent',
    error,
    crmSender: meta.crmSender,
    dealId: meta.dealId,
    mediaUrl: url,
    mediaType: tipo,
  })
  if (error) throw error
}

function rotuloDaMidia(tipo: TipoDeMidia): string {
  if (tipo === 'image') return '[imagem]'
  if (tipo === 'video') return '[vídeo]'
  if (tipo === 'ptt') return '[mensagem de voz]'
  if (tipo === 'audio') return '[áudio]'
  return '[documento]'
}

export async function sendWhatsAppChunked(
  phone: string,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  const number = formatPhoneForSend(phone)
  const chunkDelayMs = opts.chunkDelayMs ?? env.CHUNK_DELAY_MS
  const chunked = opts.chunked ?? true

  const chunks = chunked
    ? text.split('\n\n').map((c) => c.trim()).filter(Boolean)
    : [text.trim()]

  if (chunks.length === 0) {
    logger.warn({ phone: number.slice(-4) }, 'sendWhatsAppChunked: texto vazio')
    return
  }

  logger.debug({ phone: number.slice(-4), chunks: chunks.length }, 'Enviando em chunks')

  let error: unknown
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (!chunk) continue
      await postToUazapi({ number, text: chunk, delay: '3000' })
      if (i < chunks.length - 1) await sleep(chunkDelayMs)
    }
  } catch (e) {
    error = e
  }
  // Grava a mensagem completa (não fragmentada) no log persistente
  logOutbound({
    toPhone: number,
    content: text,
    status: error ? 'error' : 'sent',
    error,
    crmSender: opts.crmSender,
    dealId: opts.dealId,
  })
  if (error) throw error
}

export async function sendFallbackMessage(phone: string, dealId?: string): Promise<void> {
  await sendWhatsApp(
    phone,
    'Tive algum problema aqui no meu whatsapp, pode repetir o que você escreveu? 🙏',
    { crmSender: 'system_fallback', dealId },
  )
  logger.warn({ phone: phone.slice(-4) }, 'Fallback message enviado')
}

export async function sendMemoryClearedMessage(phone: string): Promise<void> {
  await sendWhatsApp(phone, 'Memória limpa! podemos começar do zero.', {
    crmSender: 'system_comando',
  })
}
