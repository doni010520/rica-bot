/**
 * tests/integration/webhook.test.ts
 *
 * Teste de integração do fluxo do webhook.
 * Mocka todas as dependências externas (DB, Redis, OpenAI, uazapi).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/index.js'

// ─── mocks ────────────────────────────────────────────────────────────────────

// Mock do buffer (evita conexão real com Redis/BullMQ)
vi.mock('../../src/buffer/message-buffer.js', () => ({
  getMessageBuffer: () => ({
    push: vi.fn().mockResolvedValue(undefined),
    startWorker: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}))

// Mock do DB (evita conexão real com Postgres)
vi.mock('../../src/lib/db.js', () => ({
  getPool: () => ({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
  checkDbConnection: vi.fn().mockResolvedValue(true),
  closePool: vi.fn().mockResolvedValue(undefined),
}))

// Mock do lidia (evita query no Supabase)
vi.mock('../../src/lidia/status.js', () => ({
  checkLidiaStatus: vi.fn().mockResolvedValue({ exists: true, lidia: 'ON' }),
  createLeadEntry: vi.fn().mockResolvedValue(undefined),
  setLidiaStatus: vi.fn().mockResolvedValue(undefined),
  detectTakeoverCommand: vi.fn().mockReturnValue(null),
}))

// Mock do reset-followup (fire-and-forget)
vi.mock('../../src/crm/reset-followup.js', () => ({
  resetFollowup: vi.fn(),
}))

// Mock do resolveMessageText
vi.mock('../../src/media/processors.js', () => ({
  resolveMessageText: vi.fn().mockResolvedValue('Olá, quero saber sobre diagnóstico'),
}))

// ─── testes ───────────────────────────────────────────────────────────────────

describe('POST /webhook/uazapi', () => {
  let app: FastifyInstance

  const textWebhookPayload = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511999887766@s.whatsapp.net', fromMe: false, id: 'MSG001' },
      pushName: 'João',
      message: { conversation: 'Olá, quero saber sobre diagnóstico' },
      messageType: 'conversation',
      messageTimestamp: 1716389200,
    },
  }

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('retorna 200 para payload de texto válido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/uazapi',
      payload: textWebhookPayload,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('retorna JSON com status ok', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/uazapi',
      payload: textWebhookPayload,
      headers: { 'content-type': 'application/json' },
    })
    const body = res.json<{ status: string }>()
    expect(body.status).toBe('ok')
  })

  it('retorna 200 mesmo para payload inválido (ack sempre pro uazapi)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/uazapi',
      payload: { invalid: true },
      headers: { 'content-type': 'application/json' },
    })
    // uazapi deve receber 200 sempre para não retentar
    expect(res.statusCode).toBe(200)
  })

  it('retorna 200 para mensagem fromMe (takeover)', async () => {
    const fromMePayload = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: '5581988877766@s.whatsapp.net', fromMe: true, id: 'MSG002' },
        pushName: '',
        message: { conversation: 'Roberta aqui!' },
        messageType: 'conversation',
      },
    }
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/uazapi',
      payload: fromMePayload,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('retorna 200 para mensagem de grupo (deve ignorar)', async () => {
    const groupPayload = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: '5511999-1620888@g.us', fromMe: false, id: 'MSG003' },
        pushName: 'Grupo',
        message: { conversation: 'oi' },
      },
    }
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/uazapi',
      payload: groupPayload,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('GET /ready (com DB ok)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('retorna 200 quando DB está ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ checks: { postgres: string } }>()
    expect(body.checks.postgres).toBe('ok')
  })
})
