/**
 * tests/unit/webhook-schema.test.ts
 * Testes para parseWebhookPayload — garante que payloads do uazapi são parseados.
 */

import { describe, it, expect } from 'vitest'
import { parseWebhookPayload } from '../../src/uazapi/webhook-schema.js'

// ─── fixtures ────────────────────────────────────────────────────────────────

const textPayload = {
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5511999887766@s.whatsapp.net', fromMe: false, id: 'MSG001' },
    pushName: 'João Silva',
    message: { conversation: 'Olá, quero saber sobre diagnóstico' },
    messageType: 'conversation',
    messageTimestamp: 1716389200,
  },
}

const audioPayload = {
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5581988877766@s.whatsapp.net', fromMe: false, id: 'MSG002' },
    pushName: 'Maria',
    message: {
      audioMessage: {
        url: 'https://media.uazapi.com/audio/123.ogg',
        mimetype: 'audio/ogg',
        seconds: 12,
      },
    },
    messageType: 'audioMessage',
    messageTimestamp: 1716389300,
  },
}

const imagePayload = {
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5511999887766@s.whatsapp.net', fromMe: false, id: 'MSG003' },
    pushName: 'Pedro',
    message: {
      imageMessage: {
        url: 'https://media.uazapi.com/img/abc.jpg',
        mimetype: 'image/jpeg',
        caption: 'minha loja',
      },
    },
    messageType: 'imageMessage',
  },
}

const fromMePayload = {
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5581988877766@s.whatsapp.net', fromMe: true, id: 'MSG004' },
    pushName: '',
    message: { conversation: 'Roberta aqui!' },
    messageType: 'conversation',
  },
}

const groupPayload = {
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5511999-1620888@g.us', fromMe: false, id: 'MSG005' },
    pushName: 'Grupo',
    message: { conversation: 'oi grupo' },
  },
}

// ─── testes ──────────────────────────────────────────────────────────────────

describe('parseWebhookPayload()', () => {
  describe('mensagem de texto', () => {
    it('parseia corretamente', () => {
      const result = parseWebhookPayload(textPayload)
      expect(result).not.toBeNull()
      expect(result?.mediaType).toBe('text')
      expect(result?.text).toBe('Olá, quero saber sobre diagnóstico')
      expect(result?.fromMe).toBe(false)
      expect(result?.phone).toBe('5511999887766')
      expect(result?.displayName).toBe('João Silva')
    })
  })

  describe('mensagem de áudio', () => {
    it('parseia corretamente', () => {
      const result = parseWebhookPayload(audioPayload)
      expect(result).not.toBeNull()
      expect(result?.mediaType).toBe('audio')
      expect(result?.audioUrl).toBe('https://media.uazapi.com/audio/123.ogg')
      expect(result?.mimetype).toBe('audio/ogg')
      expect(result?.text).toBeNull()
    })
  })

  describe('mensagem de imagem com legenda', () => {
    it('parseia corretamente', () => {
      const result = parseWebhookPayload(imagePayload)
      expect(result).not.toBeNull()
      expect(result?.mediaType).toBe('image')
      expect(result?.imageUrl).toBe('https://media.uazapi.com/img/abc.jpg')
      expect(result?.text).toBe('minha loja') // legenda
    })
  })

  describe('mensagem fromMe=true', () => {
    it('parseia com fromMe=true', () => {
      const result = parseWebhookPayload(fromMePayload)
      expect(result).not.toBeNull()
      expect(result?.fromMe).toBe(true)
      expect(result?.text).toBe('Roberta aqui!')
    })
  })

  describe('mensagem de grupo', () => {
    it('retorna null (grupos ignorados)', () => {
      const result = parseWebhookPayload(groupPayload)
      expect(result).toBeNull()
    })
  })

  describe('payload inválido', () => {
    it('retorna null para payload vazio', () => {
      expect(parseWebhookPayload({})).toBeNull()
    })
    it('retorna null para null', () => {
      expect(parseWebhookPayload(null)).toBeNull()
    })
    it('retorna null para string', () => {
      expect(parseWebhookPayload('texto')).toBeNull()
    })
    it('retorna null sem key', () => {
      expect(parseWebhookPayload({ data: {} })).toBeNull()
    })
  })

  describe('extração de telefone', () => {
    it('remove @s.whatsapp.net do remoteJid', () => {
      const result = parseWebhookPayload(textPayload)
      expect(result?.phone).not.toContain('@')
    })
    it('preserva código do país', () => {
      const result = parseWebhookPayload(textPayload)
      expect(result?.phone).toBe('5511999887766')
    })
  })

  describe('timestamp', () => {
    it('converte messageTimestamp para número', () => {
      const result = parseWebhookPayload(textPayload)
      expect(typeof result?.timestamp).toBe('number')
      expect(result?.timestamp).toBe(1716389200)
    })
    it('usa Date.now() quando timestamp ausente', () => {
      const payload = { ...textPayload, data: { ...textPayload.data, messageTimestamp: undefined } }
      const before = Date.now() / 1000 - 1
      const result = parseWebhookPayload(payload)
      expect(result?.timestamp).toBeGreaterThan(before)
    })
  })
})
