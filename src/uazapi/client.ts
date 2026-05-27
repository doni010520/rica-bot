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

// Payload exato que a uazapi aceita (confirmado nos nós "enviar mensagem*" do n8n)
type UazapiSendPayload = {
  number: string
  text: string
  delay?: string
}

type SendOptions = {
  chunkDelayMs?: number | undefined
  chunked?: boolean | undefined
}

async function postToUazapi(body: UazapiSendPayload): Promise<void> {
  const url = `${env.UAZAPI_BASE_URL}/send/text`

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

export async function sendWhatsApp(phone: string, text: string): Promise<void> {
  const number = formatPhoneForSend(phone)
  logger.debug({ phone: number.slice(-4), textLen: text.length }, 'sendWhatsApp')
  await postToUazapi({ number, text, delay: '3000' })
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

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (!chunk) continue
    await postToUazapi({ number, text: chunk, delay: '3000' })
    if (i < chunks.length - 1) await sleep(chunkDelayMs)
  }
}

export async function sendFallbackMessage(phone: string): Promise<void> {
  await sendWhatsApp(phone, 'Tive algum problema aqui no meu whatsapp, pode repetir o que você escreveu? 🙏')
  logger.warn({ phone: phone.slice(-4) }, 'Fallback message enviado')
}

export async function sendMemoryClearedMessage(phone: string): Promise<void> {
  await sendWhatsApp(phone, 'Memória limpa! podemos começar do zero.')
}
