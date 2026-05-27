/**
 * src/media/processors.ts
 *
 * Processadores de mídia — usam a API do uazapi /message/download
 * que já descriptografa o arquivo (CDN do WhatsApp serve blobs criptografados
 * que não podem ir direto pro OpenAI).
 *
 * Endpoints uazapi v2:
 *   POST /message/download
 *     body: { id, return_link?, return_base64?, transcribe?, generate_mp3?, openai_apikey? }
 *     resposta: { fileURL?, base64Data?, transcription?, mimetype }
 *
 * Estratégia:
 *   - Áudio:    transcribe=true → uazapi devolve transcrição (poupa round-trip Whisper)
 *   - Imagem:   return_link=true → URL descriptografada → passa direto pro Vision GPT-4o
 *   - PDF/doc:  return_link=true → baixa pelo fileURL → pdf-parse
 *
 * Baseado nas implementações funcionais em camila-agent e fp-solar-agent.
 */

import OpenAI from 'openai'
import pdfParse from 'pdf-parse'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import type { ParsedMessage } from '../uazapi/webhook-schema.js'

// ─── cliente OpenAI (lazy) ───────────────────────────────────────────────────

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  return _openai
}

// ─── chamada genérica ao /message/download da uazapi ─────────────────────────

type DownloadResult = {
  fileURL?: string
  base64Data?: string
  transcription?: string
  mimetype?: string
}

async function uazapiDownload(opts: {
  messageId: string
  returnLink?: boolean
  returnBase64?: boolean
  transcribe?: boolean
  generateMp3?: boolean
}): Promise<DownloadResult | null> {
  const body: Record<string, unknown> = {
    id: opts.messageId,
    return_link: opts.returnLink ?? false,
    return_base64: opts.returnBase64 ?? false,
    transcribe: opts.transcribe ?? false,
    generate_mp3: opts.generateMp3 ?? false,
  }

  // Pra transcribe, uazapi pede a chave OpenAI explicitamente
  if (opts.transcribe) {
    body['openai_apikey'] = env.OPENAI_API_KEY
  }

  try {
    const res = await fetch(`${env.UAZAPI_BASE_URL}/message/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: env.UAZAPI_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000), // áudio longo pode demorar
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      logger.warn(
        { status: res.status, messageId: opts.messageId, body: text.slice(0, 200) },
        'uazapi /message/download non-ok',
      )
      return null
    }

    return (await res.json().catch(() => null)) as DownloadResult | null
  } catch (err) {
    logger.error({ err, messageId: opts.messageId }, 'uazapi /message/download falhou')
    return null
  }
}

// ─── áudio → texto ───────────────────────────────────────────────────────────

/**
 * Transcreve áudio via uazapi (transcribe=true).
 * Fallback: se uazapi não retornar transcription, baixa base64 e usa Whisper local.
 */
export async function transcribeAudio(messageId: string): Promise<string> {
  logger.debug({ messageId }, 'Transcrevendo áudio via uazapi')

  // 1. Tenta transcribe direto via uazapi (mais rápido, 1 round-trip)
  const direct = await uazapiDownload({
    messageId,
    transcribe: true,
    returnLink: false,
    returnBase64: false,
  })

  if (direct?.transcription && direct.transcription.trim()) {
    logger.info({ textLen: direct.transcription.length }, 'Áudio transcrito (uazapi)')
    return `[Áudio transcrito]: ${direct.transcription.trim()}`
  }

  logger.debug({ messageId }, 'Fallback: baixando base64 pro Whisper local')

  // 2. Fallback: base64 → Whisper
  const b64result = await uazapiDownload({ messageId, returnBase64: true })
  const base64Data = b64result?.base64Data
  if (!base64Data) {
    return '[Áudio recebido, mas não foi possível baixar pra transcrever]'
  }

  const mimetype = b64result.mimetype ?? 'audio/ogg'
  const ext = mimetypeToExtension(mimetype)
  const audioBuffer = Buffer.from(base64Data, 'base64')

  try {
    const file = new File([audioBuffer], `audio.${ext}`, { type: mimetype })
    const transcription = await getOpenAI().audio.transcriptions.create({
      file,
      model: env.OPENAI_WHISPER_MODEL,
      language: 'pt',
      response_format: 'text',
    })
    const text =
      typeof transcription === 'string'
        ? transcription
        : (transcription as { text?: string }).text ?? ''
    logger.info({ textLen: text.length }, 'Áudio transcrito (Whisper local)')
    return `[Áudio transcrito]: ${text.trim()}`
  } catch (err) {
    logger.error({ err }, 'Whisper local falhou')
    return '[Áudio recebido, mas não foi possível transcrever]'
  }
}

// ─── imagem → descrição (GPT-4o Vision) ──────────────────────────────────────

export async function analyzeImage(
  messageId: string,
  caption?: string | null,
): Promise<string> {
  logger.debug({ messageId }, 'Pegando URL da imagem via uazapi')

  // Vision aceita URL direto (mais barato que base64)
  const result = await uazapiDownload({ messageId, returnLink: true })
  const fileURL = result?.fileURL

  if (!fileURL) {
    // Fallback pra base64 caso uazapi não retorne fileURL
    const b64 = await uazapiDownload({ messageId, returnBase64: true })
    if (!b64?.base64Data) return '[Imagem recebida, mas não foi possível acessar]'
    return await analyzeImageBase64(b64.base64Data, b64.mimetype ?? 'image/jpeg', caption)
  }

  try {
    const response = await getOpenAI().chat.completions.create({
      model: env.OPENAI_VISION_MODEL,
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileURL, detail: 'auto' } },
            {
              type: 'text',
              text: caption
                ? `Descreva esta imagem em português. O usuário também enviou a legenda: "${caption}"`
                : 'Descreva esta imagem em português de forma detalhada.',
            },
          ],
        },
      ],
    })
    const description = response.choices[0]?.message.content ?? ''
    logger.info({ descLen: description.length }, 'Imagem analisada')
    const prefix = caption ? `[Imagem com legenda "${caption}"]: ` : '[Imagem]: '
    return `${prefix}${description}`
  } catch (err) {
    logger.error({ err }, 'Vision falhou')
    return '[Imagem recebida, mas não foi possível analisar]'
  }
}

async function analyzeImageBase64(
  base64: string,
  mimetype: string,
  caption?: string | null,
): Promise<string> {
  const dataUrl = `data:${mimetype};base64,${base64}`
  const response = await getOpenAI().chat.completions.create({
    model: env.OPENAI_VISION_MODEL,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
          {
            type: 'text',
            text: caption
              ? `Descreva esta imagem em português. Legenda: "${caption}"`
              : 'Descreva esta imagem em português de forma detalhada.',
          },
        ],
      },
    ],
  })
  const description = response.choices[0]?.message.content ?? ''
  const prefix = caption ? `[Imagem com legenda "${caption}"]: ` : '[Imagem]: '
  return `${prefix}${description}`
}

// ─── PDF/documento → texto ───────────────────────────────────────────────────

export async function extractDocument(messageId: string): Promise<string> {
  logger.debug({ messageId }, 'Baixando documento via uazapi')

  const result = await uazapiDownload({ messageId, returnLink: true })
  let buffer: Buffer | null = null
  let mimetype = result?.mimetype ?? ''

  if (result?.fileURL) {
    try {
      const res = await fetch(result.fileURL)
      if (res.ok) buffer = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      logger.warn({ err }, 'Falha ao baixar fileURL do documento')
    }
  }

  // Fallback: base64
  if (!buffer) {
    const b64 = await uazapiDownload({ messageId, returnBase64: true })
    if (b64?.base64Data) {
      buffer = Buffer.from(b64.base64Data, 'base64')
      mimetype = b64.mimetype ?? mimetype
    }
  }

  if (!buffer) {
    return '[Documento recebido, mas não foi possível baixar]'
  }

  // PDF — extrai texto
  if (mimetype.includes('pdf') || mimetype === 'application/octet-stream') {
    try {
      const data = await pdfParse(buffer)
      const text = data.text.trim()
      const MAX_CHARS = 8000
      const truncated =
        text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n[... PDF truncado]' : text
      logger.info({ pages: data.numpages, textLen: text.length }, 'PDF extraído')
      return `[Documento PDF]:\n${truncated}`
    } catch (err) {
      logger.error({ err }, 'pdf-parse falhou')
      return '[Documento PDF recebido, mas não foi possível extrair texto]'
    }
  }

  return `[Documento ${mimetype || 'desconhecido'} recebido — tipo não suportado para extração de texto]`
}

// ─── roteador (chamado pelo handler) ─────────────────────────────────────────

export async function resolveMessageText(msg: ParsedMessage): Promise<string> {
  switch (msg.mediaType) {
    case 'text':
      return msg.text ?? ''

    case 'audio':
      if (!msg.messageId) return '[Áudio recebido — sem messageid]'
      return await transcribeAudio(msg.messageId)

    case 'image':
      if (!msg.messageId) return '[Imagem recebida — sem messageid]'
      return await analyzeImage(msg.messageId, msg.text)

    case 'document':
      if (!msg.messageId) return '[Documento recebido — sem messageid]'
      return await extractDocument(msg.messageId)

    case 'other':
    default:
      return msg.text ?? '[Mensagem de tipo não suportado]'
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function mimetypeToExtension(mimetype: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/aac': 'aac',
  }
  return map[mimetype] ?? 'ogg'
}
