/**
 * src/media/processors.ts
 *
 * Processadores de mídia — equivalentes dos grupos B e E do n8n.
 *
 * Fluxo n8n:
 *   Áudio:    download_audio → Code1 → transcribe_audio (Whisper) → message2
 *   Imagem:   download_image → Code2 → describe_image (GPT-4o) → message2
 *   PDF:      download_pdf → Code3 → Extract from File → message2
 *   Texto:    direto → message2
 *
 * Aqui: uma função por tipo, todas retornam string para o agent.
 */

import OpenAI from 'openai'
import pdfParse from 'pdf-parse'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'

// ─── cliente OpenAI ───────────────────────────────────────────────────────────

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY })
}

// ─── download ─────────────────────────────────────────────────────────────────

/**
 * Baixa arquivo de mídia de uma URL e retorna como Buffer.
 * Replica: download_audio, download_image, download_pdf do n8n.
 */
export async function downloadMedia(url: string): Promise<Buffer> {
  logger.debug({ url: url.slice(0, 60) }, 'Baixando mídia')

  const res = await fetch(url, {
    headers: {
      // uazapi pode exigir token para URLs de mídia privadas
      Authorization: `Bearer ${env.UAZAPI_TOKEN}`,
    },
  })

  if (!res.ok) {
    throw new Error(`download_media: ${res.status} em ${url}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ─── áudio → texto (Whisper) ─────────────────────────────────────────────────

/**
 * Transcreve áudio via OpenAI Whisper.
 * Replica: transcribe_audio do n8n (openAi node, audio.transcribe).
 *
 * @param audioBuffer - Buffer do arquivo de áudio
 * @param mimetype - MIME type do áudio (default: audio/ogg)
 * @returns Transcrição em texto
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimetype = 'audio/ogg',
): Promise<string> {
  const openai = getOpenAI()

  // Whisper precisa de um File object com nome que inclua extensão
  const extension = mimetypeToExtension(mimetype)
  const file = new File([audioBuffer], `audio.${extension}`, { type: mimetype })

  logger.debug({ sizeKb: Math.round(audioBuffer.length / 1024), mimetype }, 'Transcrevendo áudio')

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: env.OPENAI_WHISPER_MODEL,
    language: 'pt',
    response_format: 'text',
  })

  const text = typeof transcription === 'string' ? transcription : (transcription as { text?: string }).text ?? ''

  logger.info({ textLen: text.length }, 'Áudio transcrito')
  return `[Áudio transcrito]: ${text}`
}

// ─── imagem → descrição (GPT-4o Vision) ──────────────────────────────────────

/**
 * Descreve imagem via GPT-4o Vision.
 * Replica: describe_image do n8n (openAi node, image.analyze).
 *
 * @param imageBuffer - Buffer da imagem
 * @param mimetype - MIME type da imagem
 * @param caption - Legenda enviada com a imagem (se houver)
 * @returns Descrição da imagem
 */
export async function analyzeImage(
  imageBuffer: Buffer,
  mimetype = 'image/jpeg',
  caption?: string | null,
): Promise<string> {
  const openai = getOpenAI()
  const base64 = imageBuffer.toString('base64')
  const dataUrl = `data:${mimetype};base64,${base64}`

  logger.debug({ sizeKb: Math.round(imageBuffer.length / 1024), mimetype }, 'Analisando imagem')

  const response = await openai.chat.completions.create({
    model: env.OPENAI_VISION_MODEL,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: dataUrl, detail: 'auto' },
          },
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
}

// ─── PDF → texto ──────────────────────────────────────────────────────────────

/**
 * Extrai texto de um PDF.
 * Replica: Extract from File do n8n.
 *
 * @param pdfBuffer - Buffer do arquivo PDF
 * @returns Texto extraído (truncado em 8000 chars para não exceder context)
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  logger.debug({ sizeKb: Math.round(pdfBuffer.length / 1024) }, 'Extraindo texto do PDF')

  const data = await pdfParse(pdfBuffer)
  const text = data.text.trim()

  // Limita para não explodir o context window do LLM
  const MAX_CHARS = 8000
  const truncated = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n[... PDF truncado]' : text

  logger.info({ pages: data.numpages, textLen: text.length }, 'PDF extraído')
  return `[Documento PDF]:\n${truncated}`
}

// ─── router de mídia ──────────────────────────────────────────────────────────

import type { ParsedMessage } from '../uazapi/webhook-schema.js'

/**
 * Roteador de tipo de mensagem — equivalente do Switch6 (type_of_message) do n8n.
 * Dado uma mensagem parseada, retorna o texto normalizado para o agent.
 *
 * Sequência no n8n:
 *   [0 text] → message2 direto
 *   [1 audio] → download → Code1 → Whisper → message2
 *   [2 image] → download → Code2 → GPT-4o → message2
 *   [3 pdf] → download → Code3 → Extract → message2
 *   [4/5 other] → message2 (texto genérico)
 */
export async function resolveMessageText(msg: ParsedMessage): Promise<string> {
  switch (msg.mediaType) {
    case 'text':
      return msg.text ?? ''

    case 'audio': {
      if (!msg.audioUrl) return '[Áudio recebido — URL não disponível]'
      const buffer = await downloadMedia(msg.audioUrl)
      return await transcribeAudio(buffer, msg.mimetype ?? 'audio/ogg')
    }

    case 'image': {
      if (!msg.imageUrl) return '[Imagem recebida — URL não disponível]'
      const buffer = await downloadMedia(msg.imageUrl)
      return await analyzeImage(buffer, msg.mimetype ?? 'image/jpeg', msg.text)
    }

    case 'document': {
      if (!msg.documentUrl) return '[Documento recebido — URL não disponível]'
      const buffer = await downloadMedia(msg.documentUrl)
      const mimetype = msg.mimetype ?? ''
      if (mimetype.includes('pdf') || mimetype === 'application/octet-stream') {
        return await extractPdfText(buffer)
      }
      return '[Documento recebido — tipo não suportado para extração de texto]'
    }

    case 'other':
    default:
      return msg.text ?? '[Mensagem de tipo não suportado]'
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function mimetypeToExtension(mimetype: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/aac': 'aac',
  }
  return map[mimetype] ?? 'ogg'
}
