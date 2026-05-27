/**
 * src/uazapi/webhook-schema.ts
 *
 * Schema Zod do payload que o uazapi (benitechlab) envia no webhook.
 *
 * Formato confirmado em 27/mai/2026 — diferente do Evolution API.
 * Estrutura real:
 *   {
 *     "BaseUrl": "...",
 *     "EventType": "messages",
 *     "instanceName": "RICA",
 *     "owner": "...",
 *     "chat":    { wa_name, wa_chatid, name, ... },
 *     "message": { id, chatid, fromMe, text, content, type, mediaType,
 *                  messageType, messageTimestamp, messageid, senderName, ... },
 *     "token":   "..."
 *   }
 *
 * Replica a extração do nó Get_Info do n8n:
 *   full_name  = body.chat.wa_name
 *   telefone   = body.chat.wa_chatid.split('@').first()
 *   message    = body.message.text
 *   image_url  = body.message.content.URL
 *   audio_url  = body.message.content.URL
 *   pdf_url    = body.message.documentMessage.url
 *   tipo       = body.message.messageType
 *   mediaKey   = body.message.content.mediaKey
 *   mimetype   = body.message.content.mimetype
 *   remoteJid  = body.message.chatid
 *   id         = body.message.messageid
 */

import { z } from 'zod'

// ─── tipos de mensagem ────────────────────────────────────────────────────────

export type MediaType = 'text' | 'audio' | 'image' | 'document' | 'other'

// ─── sub-schemas ──────────────────────────────────────────────────────────────

/**
 * `message.content` pode vir como:
 *   - string (texto puro)
 *   - objeto com URL/mediaKey/mimetype (mídia)
 *   - vazio/undefined
 *
 * Tratamos com union pra cobrir os casos.
 */
const MessageContentSchema = z.union([
  z.string(),
  z
    .object({
      URL: z.string().optional(),
      url: z.string().optional(),
      mediaKey: z.string().optional(),
      mimetype: z.string().optional(),
      fileName: z.string().optional(),
      caption: z.string().optional(),
    })
    .passthrough(),
  z.null(),
])

const ChatSchema = z
  .object({
    wa_name: z.string().optional(),
    wa_chatid: z.string().optional(),
    wa_isGroup: z.boolean().optional(),
    name: z.string().optional(),
    lead_name: z.string().optional(),
  })
  .passthrough()
  .optional()

const MessageSchema = z
  .object({
    id: z.string().optional(),
    messageid: z.string().optional(),
    chatid: z.string().optional(),
    fromMe: z.boolean().optional(),
    text: z.string().optional(),
    content: MessageContentSchema.optional(),
    type: z.string().optional(),           // 'text' | 'audio' | 'image' | 'document'
    mediaType: z.string().optional(),       // 'audio' | 'image' | 'document' (vazio quando texto)
    messageType: z.string().optional(),     // 'Conversation' | 'audioMessage' | 'imageMessage' | 'documentMessage' | 'revokeMessage'
    messageTimestamp: z.union([z.string(), z.number()]).optional(),
    senderName: z.string().optional(),
    sender: z.string().optional(),
    sender_pn: z.string().optional(),
    isGroup: z.boolean().optional(),
    wasSentByApi: z.boolean().optional(),
    // legacy / sub-estruturas que o n8n também olha
    documentMessage: z
      .object({
        url: z.string().optional(),
        mimetype: z.string().optional(),
        fileName: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .optional()

// ─── schema principal ─────────────────────────────────────────────────────────

export const UazapiWebhookSchema = z
  .object({
    BaseUrl: z.string().optional(),
    EventType: z.string().optional(),
    instanceName: z.string().optional(),
    owner: z.string().optional(),
    chatSource: z.string().optional(),
    chat: ChatSchema,
    message: MessageSchema,
    token: z.string().optional(),
  })
  .passthrough()

export type UazapiWebhook = z.infer<typeof UazapiWebhookSchema>

// ─── parsed message (resultado normalizado) ───────────────────────────────────

export type ParsedMessage = {
  /** Telefone normalizado: só dígitos, com código do país */
  phone: string
  /** true se mensagem foi enviada pela própria conta (operador ou Rica) */
  fromMe: boolean
  /** true se foi a própria API que enviou (eco do que rica-bot mandou) — deve ser ignorada */
  wasSentByApi: boolean
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
  /** Timestamp Unix (segundos) da mensagem */
  timestamp: number
  /** true se cliente apagou a mensagem (revokeMessage) — deve ser ignorada */
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
  const msg = payload.message
  const chat = payload.chat

  // Sem `message` ou sem identificadores básicos, não tem como processar
  if (!msg) return null

  // Identifica telefone: prioridade chatid > chat.wa_chatid > sender_pn
  const chatId = msg.chatid ?? chat?.wa_chatid ?? msg.sender_pn ?? ''
  const rawPhone = chatId.replace(/@.*/, '').trim()
  if (!rawPhone) return null
  // Grupos têm "-" no número — ignorar
  if (rawPhone.includes('-')) return null
  // Flag explícita de grupo (caso disponível)
  if (msg.isGroup || chat?.wa_isGroup) return null

  // ID da mensagem (obrigatório p/ logging e dedup)
  const messageId = msg.messageid ?? msg.id ?? ''
  if (!messageId) return null

  // fromMe + wasSentByApi:
  //   wasSentByApi=true → eco do que rica-bot enviou (ignorar)
  //   fromMe=true && wasSentByApi=false → operador humano digitou no WhatsApp
  //   fromMe=false → mensagem do cliente
  const fromMe = msg.fromMe ?? false
  const wasSentByApi = msg.wasSentByApi ?? false

  // Nome do contato
  const displayName = msg.senderName ?? chat?.wa_name ?? chat?.name ?? chat?.lead_name ?? ''

  // REVOKE — cliente apagou a mensagem
  const isRevoke = msg.messageType === 'revokeMessage' || msg.type === 'revoke'

  // Timestamp: pode vir em ms (uazapi) ou s. Normaliza pra segundos Unix.
  let timestamp = Number(msg.messageTimestamp ?? Date.now() / 1000)
  if (timestamp > 9_999_999_999) timestamp = Math.floor(timestamp / 1000)

  // Mídia
  const { mediaType, text, audioUrl, imageUrl, documentUrl, mimetype } = extractMediaInfo(msg)

  return {
    phone: rawPhone,
    fromMe,
    wasSentByApi,
    messageId,
    displayName,
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

/**
 * Extrai mídia e texto do `message` do uazapi.
 *
 * mediaType vem em `message.type` ('text' | 'audio' | 'image' | 'document').
 * Mídia (URL, mediaKey, mimetype) vem dentro de `message.content` quando é objeto.
 */
function extractMediaInfo(msg: z.infer<typeof MessageSchema> & object): {
  mediaType: MediaType
  text: string | null
  audioUrl: string | null
  imageUrl: string | null
  documentUrl: string | null
  mimetype: string | null
} {
  const type = (msg.type ?? '').toLowerCase()
  const messageType = (msg.messageType ?? '').toLowerCase()
  const mediaTypeRaw = (msg.mediaType ?? '').toLowerCase()

  // Texto: tanto `text` quanto `content` (quando é string) servem
  const textFromContent = typeof msg.content === 'string' ? msg.content : null
  const text = msg.text ?? textFromContent ?? null

  // Mídia: content como objeto contém URL/mediaKey/mimetype
  const contentObj =
    msg.content && typeof msg.content === 'object' && !Array.isArray(msg.content)
      ? msg.content
      : null
  const mediaUrl = contentObj?.URL ?? contentObj?.url ?? null
  const mediaMimetype = contentObj?.mimetype ?? null

  // Audio
  if (type === 'audio' || mediaTypeRaw === 'audio' || messageType === 'audiomessage') {
    return {
      mediaType: 'audio',
      text: null,
      audioUrl: mediaUrl,
      imageUrl: null,
      documentUrl: null,
      mimetype: mediaMimetype ?? 'audio/ogg',
    }
  }

  // Image
  if (type === 'image' || mediaTypeRaw === 'image' || messageType === 'imagemessage') {
    return {
      mediaType: 'image',
      // imagem pode vir com caption no .text
      text: text,
      audioUrl: null,
      imageUrl: mediaUrl,
      documentUrl: null,
      mimetype: mediaMimetype ?? 'image/jpeg',
    }
  }

  // Document / PDF
  if (
    type === 'document' ||
    mediaTypeRaw === 'document' ||
    messageType === 'documentmessage' ||
    msg.documentMessage
  ) {
    return {
      mediaType: 'document',
      text: null,
      audioUrl: null,
      imageUrl: null,
      documentUrl: mediaUrl ?? msg.documentMessage?.url ?? null,
      mimetype: mediaMimetype ?? msg.documentMessage?.mimetype ?? 'application/octet-stream',
    }
  }

  // Texto (padrão)
  if (text) {
    return { mediaType: 'text', text, audioUrl: null, imageUrl: null, documentUrl: null, mimetype: null }
  }

  return { mediaType: 'other', text: null, audioUrl: null, imageUrl: null, documentUrl: null, mimetype: null }
}
