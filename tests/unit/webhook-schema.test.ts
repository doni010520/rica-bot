/**
 * tests/unit/webhook-schema.test.ts
 *
 * Testes para parseWebhookPayload usando o formato real do uazapi (benitechlab).
 * Confirmado em produção em 27/mai/2026.
 */

import { describe, it, expect } from 'vitest'
import { parseWebhookPayload } from '../../src/uazapi/webhook-schema.js'

// ─── fixtures ────────────────────────────────────────────────────────────────

const textPayload = {
  BaseUrl: 'https://benitechlab.uazapi.com',
  EventType: 'messages',
  instanceName: 'RICA',
  owner: '5511980143793',
  chat: {
    wa_name: 'João Silva',
    wa_chatid: '5511999887766@s.whatsapp.net',
    wa_isGroup: false,
    name: 'João Silva',
  },
  message: {
    id: '5511980143793:MSG001',
    messageid: 'MSG001',
    chatid: '5511999887766@s.whatsapp.net',
    fromMe: false,
    text: 'Oi, quero saber sobre diagnóstico',
    content: 'Oi, quero saber sobre diagnóstico',
    type: 'text',
    mediaType: '',
    messageType: 'Conversation',
    messageTimestamp: 1779888766000, // ms
    senderName: 'João Silva',
    sender: '126804715126897@lid',
    sender_pn: '5511999887766@s.whatsapp.net',
    isGroup: false,
    wasSentByApi: false,
  },
  token: 'fake-token',
}

const audioPayload = {
  BaseUrl: 'https://benitechlab.uazapi.com',
  EventType: 'messages',
  instanceName: 'RICA',
  chat: { wa_name: 'Maria', wa_chatid: '5581988877766@s.whatsapp.net', wa_isGroup: false },
  message: {
    messageid: 'MSG002',
    chatid: '5581988877766@s.whatsapp.net',
    fromMe: false,
    type: 'audio',
    mediaType: 'audio',
    messageType: 'audioMessage',
    messageTimestamp: 1779888800000,
    senderName: 'Maria',
    content: {
      URL: 'https://media.uazapi.com/audio/123.enc',
      mediaKey: 'fake-media-key',
      mimetype: 'audio/ogg; codecs=opus',
    },
  },
}

const imagePayload = {
  BaseUrl: 'https://benitechlab.uazapi.com',
  EventType: 'messages',
  instanceName: 'RICA',
  chat: { wa_name: 'Pedro', wa_chatid: '5511999887766@s.whatsapp.net' },
  message: {
    messageid: 'MSG003',
    chatid: '5511999887766@s.whatsapp.net',
    fromMe: false,
    type: 'image',
    mediaType: 'image',
    messageType: 'imageMessage',
    messageTimestamp: 1779888900000,
    text: 'minha loja',
    content: {
      URL: 'https://media.uazapi.com/img/abc.enc',
      mediaKey: 'fake-img-key',
      mimetype: 'image/jpeg',
    },
    senderName: 'Pedro',
  },
}

const documentPayload = {
  BaseUrl: 'https://benitechlab.uazapi.com',
  EventType: 'messages',
  chat: { wa_name: 'Ana', wa_chatid: '5511960000000@s.whatsapp.net' },
  message: {
    messageid: 'MSG004',
    chatid: '5511960000000@s.whatsapp.net',
    fromMe: false,
    type: 'document',
    mediaType: 'document',
    messageType: 'documentMessage',
    messageTimestamp: 1779888950000,
    content: {
      URL: 'https://media.uazapi.com/doc/xyz.enc',
      mediaKey: 'fake-doc-key',
      mimetype: 'application/pdf',
      fileName: 'proposta.pdf',
    },
    senderName: 'Ana',
  },
}

const fromMePayload = {
  ...textPayload,
  message: {
    ...textPayload.message,
    messageid: 'MSG_FROMME',
    fromMe: true,
    text: 'Roberta aqui!',
    content: 'Roberta aqui!',
  },
}

const groupPayload = {
  BaseUrl: 'https://benitechlab.uazapi.com',
  chat: { wa_chatid: '120363042-1234567@g.us', wa_isGroup: true },
  message: {
    messageid: 'MSG_GROUP',
    chatid: '120363042-1234567@g.us',
    fromMe: false,
    text: 'mensagem de grupo',
    isGroup: true,
    type: 'text',
    messageType: 'Conversation',
    messageTimestamp: 1779889000000,
  },
}

const revokePayload = {
  ...textPayload,
  message: {
    ...textPayload.message,
    messageid: 'MSG_REV',
    messageType: 'revokeMessage',
  },
}

// ─── testes ───────────────────────────────────────────────────────────────────

describe('parseWebhookPayload — formato uazapi nativo', () => {
  describe('texto', () => {
    it('extrai phone, fromMe, messageId, displayName e texto', () => {
      const r = parseWebhookPayload(textPayload)
      expect(r).not.toBeNull()
      expect(r!.phone).toBe('5511999887766')
      expect(r!.fromMe).toBe(false)
      expect(r!.messageId).toBe('MSG001')
      expect(r!.displayName).toBe('João Silva')
      expect(r!.mediaType).toBe('text')
      expect(r!.text).toBe('Oi, quero saber sobre diagnóstico')
      expect(r!.isRevoke).toBe(false)
    })

    it('converte timestamp em ms pra segundos', () => {
      const r = parseWebhookPayload(textPayload)
      // 1779888766000 ms = 1779888766 s
      expect(r!.timestamp).toBe(1779888766)
    })
  })

  describe('áudio', () => {
    it('extrai audioUrl e mimetype', () => {
      const r = parseWebhookPayload(audioPayload)
      expect(r!.mediaType).toBe('audio')
      expect(r!.audioUrl).toBe('https://media.uazapi.com/audio/123.enc')
      expect(r!.mimetype).toBe('audio/ogg; codecs=opus')
      expect(r!.text).toBeNull()
    })
  })

  describe('imagem', () => {
    it('extrai imageUrl e caption', () => {
      const r = parseWebhookPayload(imagePayload)
      expect(r!.mediaType).toBe('image')
      expect(r!.imageUrl).toBe('https://media.uazapi.com/img/abc.enc')
      expect(r!.text).toBe('minha loja')
      expect(r!.mimetype).toBe('image/jpeg')
    })
  })

  describe('documento', () => {
    it('extrai documentUrl e mimetype', () => {
      const r = parseWebhookPayload(documentPayload)
      expect(r!.mediaType).toBe('document')
      expect(r!.documentUrl).toBe('https://media.uazapi.com/doc/xyz.enc')
      expect(r!.mimetype).toBe('application/pdf')
    })
  })

  describe('flags', () => {
    it('detecta fromMe=true', () => {
      const r = parseWebhookPayload(fromMePayload)
      expect(r!.fromMe).toBe(true)
    })

    it('detecta wasSentByApi=true (eco da própria API)', () => {
      const payload = {
        ...textPayload,
        message: { ...textPayload.message, messageid: 'MSG_API', fromMe: true, wasSentByApi: true },
      }
      const r = parseWebhookPayload(payload)
      expect(r!.wasSentByApi).toBe(true)
      expect(r!.fromMe).toBe(true)
    })

    it('rejeita mensagens de grupo (retorna null)', () => {
      const r = parseWebhookPayload(groupPayload)
      expect(r).toBeNull()
    })

    it('detecta REVOKE via messageType', () => {
      const r = parseWebhookPayload(revokePayload)
      expect(r!.isRevoke).toBe(true)
    })
  })

  describe('payloads inválidos', () => {
    it('retorna null pra payload completamente vazio', () => {
      expect(parseWebhookPayload({})).toBeNull()
    })

    it('retorna null pra payload com message vazia', () => {
      expect(parseWebhookPayload({ message: {} })).toBeNull()
    })

    it('retorna null pra payload null/undefined', () => {
      expect(parseWebhookPayload(null)).toBeNull()
      expect(parseWebhookPayload(undefined)).toBeNull()
    })
  })
})
