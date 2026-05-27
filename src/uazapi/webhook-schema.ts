/**
 * src/uazapi/webhook-schema.ts
 *
 * Schema Zod do payload que o uazapi envia no webhook.
 *
 * O uazapi segue o formato da Evolution API / Baileys.
 * Campos extraídos pelo nó Get_Info do n8n:
 *   full_name, telefone, message, image_url, audio_url, pdf_url,
 *   tipo (mediaType), mediaKey, mimetype, token, host, remoteJid, id
 *
 * NOTA: O schema é permissivo em campos opcionais (safeParse + .optional())
 * porque o payload varia dependendo do tipo de mídia.
 * Zod valida os campos que usamos; extras são ignorados.
 */

import { z } from 'zod'

// ─── tipos de mensagem ────────────────────────────────────────────────────────

export type MediaType = 'text' | 'audio' | 'image' | 'document' | 'other'

// ─── sub-schemas ──────────────────────────────────────────────────────────────

const MessageKeySchema = z.object({
  remoteJid: z.string(),            // ex: "5511999887766@s.whatsapp.net"
  fromMe: z.boolean(),
  id: z.string(),
})

const AudioMessageSchema = z.object({
  url: z.string().optional(),
  mimetype: z.string().optional(),
  fileLength: z.union([z.string(), z.number()]).optional(),
  seconds: z.number().optional(),
  mediaKey: z.string().optional(),
  directPath: z.string().optional(),
})

const ImageMessageSchema = z.object({
  url: z.string().optional(),
  mimetype: z.string().optional(),
  fileLength: z.union([z.string(), z.number()]).optional(),
  mediaKey: z.string().optional(),
  directPath: z.string().optional(),
  caption: z.string().optional(),
})

const DocumentMessageSchema = z.object({
  url: z.string().optional(),
  mimetype: z.string().optional(),
  fileLength: z.union([z.string(), z.number()]).optional(),
  mediaKey: z.string().optional(),
  directPath: z.string().optional(),
  fileName: z.string().optional(),
  title: z.string().optional(),
})

const MessageContentSchema = z.object({
  conversation: z.string().optional(),          // texto simples
  extendedTextMessage: z.object({
    text: z.string(),
  }).optional(),
  audioMessage: AudioMessageSchema.optional(),
  imageMessage: ImageMessageSchema.optional(),
  documentMessage: DocumentMessageSchema.optional(),
  documentWithCaptionMessage: z.object({
    message: z.object({
      documentMessage: DocumentMessageSchema,
    }),
  }).optional(),
})

// ─── schema principal ─────────────────────────────────────────────────────────

export const UazapiWebhookSchema = z.object({
  event: z.string().optional(),
  instance: z.string().optional(),
  // notification=REVOKE: cliente apagou a mensagem — deve ser ignorada
  notification: z.string().optional(),
  data: z.object({
    key: MessageKeySchema,
    pushName: z.string().optional(),
    message: MessageContentSchema.optional(),
    messageType: z.string().optional(),
    messageTimestamp: z.union([z.string(), z.number()]).optional(),
    mediaUrl: z.string().optional(),
    audioUrl: z.string().optional(),
    imageUrl: z.string().optional(),
    // notification também pode vir dentro de data
    notification: z.string().optional(),
  }),
  token: z.string().optional(),
  key: MessageKeySchema.optional(),
  pushName: z.string().optional(),
  message: MessageContentSchema.optional(),
  messageType: z.string().optional(),
  messageTimestamp: z.union([z.string(), z.number()]).optional(),
})

export type UazapiWebhook = z.infer<typeof UazapiWebhookSchema>

// ─── parsed message (resultado normalizado) ───────────────────────────────────

export type ParsedMessage = {
  /** Telefone normalizado: só dígitos, com código do país */
  phone: string
  /** true se mensagem foi enviada pela própria conta (operador ou Rica) */
  fromMe: boolean
  /** ID único da mensagem no WhatsApp */
  messageId: string
  /** Nome do contato no WhatsApp */
  displayName: string
  /** Tipo de mídia detectado */
  mediaType: MediaType
  /** Texto direto (se text) */
  text: string | null
  /** URL de áudio para download (se audio) */
  audioUrl: string | null
  /** URL de imagem para download (se image) */
  imageUrl: string | null
  /** URL de documento PDF para download (se document) */
  documentUrl: string | null
  /** Mimetype do arquivo de mídia */
  mimetype: string | null
  /** Timestamp Unix da mensagem */
  timestamp: number
  /** true se cliente apagou a mensagem (notification=REVOKE) — deve ser ignorada */
  isRevoke: boolean
}

/**
 * Parseia e normaliza o payload do webhook do uazapi.
 * Retorna null se o payload não tiver os campos mínimos necessários.
 */
export function parseWebhookPayload(raw: unknown): ParsedMessage | null {
  const result = UazapiWebhookSchema.safeParse(raw)
  if (!result.success) return null

  const payload = result.data

  // Normaliza key e message — podem estar na raiz ou dentro de data
  const key = payload.data.key ?? payload.key
  const messageContent = payload.data.message ?? payload.message
  const pushName = payload.data.pushName ?? payload.pushName ?? ''
  const messageType = payload.data.messageType ?? payload.messageType
  const timestamp = Number(payload.data.messageTimestamp ?? payload.messageTimestamp ?? Date.now() / 1000)

  // Detecta REVOKE (cliente apagou a mensagem)
  const isRevoke =
    payload.notification === 'REVOKE' ||
    payload.data.notification === 'REVOKE' ||
    messageType === 'revokeMessage'

  if (!key) return null

  const { remoteJid, fromMe, id } = key

  // Extrai telefone do remoteJid (remove @s.whatsapp.net e grupos)
  const rawPhone = remoteJid.replace(/@.*/, '')
  // Grupos têm "-" no número — ignorar
  if (rawPhone.includes('-')) return null

  const { mediaType, text, audioUrl, imageUrl, documentUrl, mimetype } =
    extractMediaInfo(messageContent, payload.data.audioUrl ?? payload.data.imageUrl, messageType)

  return {
    phone: rawPhone,
    fromMe,
    messageId: id,
    displayName: pushName,
    mediaType,
    text,
    audioUrl,
    imageUrl,
    documentUrl,
    mimetype,
    timestamp,
    isRevoke,
  }
}

// ─── extração de mídia ───────────────────────────────────────────────────────

function extractMediaInfo(
  msg: z.infer<typeof MessageContentSchema> | undefined,
  preResolvedUrl: string | undefined,
  messageType: string | undefined,
): {
  mediaType: MediaType
  text: string | null
  audioUrl: string | null
  imageUrl: string | null
  documentUrl: string | null
  mimetype: string | null
} {
  if (!msg) {
    return { mediaType: 'text', text: null, audioUrl: null, imageUrl: null, documentUrl: null, mimetype: null }
  }

  // Texto simples
  if (msg.conversation) {
    return { mediaType: 'text', text: msg.conversation, audioUrl: null, imageUrl: null, documentUrl: null, mimetype: null }
  }

  // Texto estendido (links, menções, formatado)
  if (msg.extendedTextMessage) {
    return { mediaType: 'text', text: msg.extendedTextMessage.text, audioUrl: null, imageUrl: null, documentUrl: null, mimetype: null }
  }

  // Áudio
  if (msg.audioMessage || messageType === 'audioMessage') {
    const audio = msg.audioMessage
    return {
      mediaType: 'audio',
      text: null,
      audioUrl: audio?.url ?? preResolvedUrl ?? null,
      imageUrl: null,
      documentUrl: null,
      mimetype: audio?.mimetype ?? 'audio/ogg',
    }
  }

  // Imagem
  if (msg.imageMessage || messageType === 'imageMessage') {
    const image = msg.imageMessage
    return {
      mediaType: 'image',
      text: image?.caption ?? null,
      audioUrl: null,
      imageUrl: image?.url ?? preResolvedUrl ?? null,
      documentUrl: null,
      mimetype: image?.mimetype ?? 'image/jpeg',
    }
  }

  // Documento / PDF
  if (msg.documentMessage || msg.documentWithCaptionMessage || messageType?.includes('document')) {
    const doc = msg.documentMessage ?? msg.documentWithCaptionMessage?.message.documentMessage
    return {
      mediaType: 'document',
      text: null,
      audioUrl: null,
      imageUrl: null,
      documentUrl: doc?.url ?? preResolvedUrl ?? null,
      mimetype: doc?.mimetype ?? 'application/octet-stream',
    }
  }

  return { mediaType: 'other', text: null, audioUrl: null, imageUrl: null, documentUrl: null, mimetype: null }
}
