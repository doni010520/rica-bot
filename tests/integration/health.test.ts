/**
 * tests/integration/health.test.ts
 * Testes dos endpoints /health e /ready (Sprint 1 — DB mockado).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/index.js'

// Mock todas as dependências para que o app suba sem infra real
vi.mock('../../src/buffer/message-buffer.js', () => ({
  getMessageBuffer: () => ({
    push: vi.fn(),
    startWorker: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../../src/lib/db.js', () => ({
  getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  checkDbConnection: vi.fn().mockResolvedValue(true),
  closePool: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/lidia/status.js', () => ({
  checkLidiaStatus: vi.fn().mockResolvedValue({ exists: true, lidia: 'ON' }),
  createLeadEntry: vi.fn(),
  setLidiaStatus: vi.fn(),
  detectTakeoverCommand: vi.fn().mockReturnValue(null),
}))

vi.mock('../../src/crm/reset-followup.js', () => ({ resetFollowup: vi.fn() }))
vi.mock('../../src/media/processors.js', () => ({ resolveMessageText: vi.fn().mockResolvedValue('') }))

describe('GET /health', () => {
  let app: FastifyInstance

  beforeAll(async () => { app = await buildApp(); await app.ready() })
  afterAll(async () => { await app.close() })

  it('retorna 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })

  it('retorna JSON com status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = res.json<{ status: string; service: string }>()
    expect(body.status).toBe('ok')
    expect(body.service).toBe('rica-bot')
  })

  it('inclui timestamp ISO válido', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = res.json<{ timestamp: string }>()
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0)
  })

  it('inclui uptime positivo', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = res.json<{ uptime: number }>()
    expect(body.uptime).toBeGreaterThan(0)
  })
})

describe('GET /ready', () => {
  let app: FastifyInstance

  beforeAll(async () => { app = await buildApp(); await app.ready() })
  afterAll(async () => { await app.close() })

  it('retorna 200 com DB mockado como ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
  })

  it('retorna status ready', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    const body = res.json<{ status: string }>()
    expect(body.status).toBe('ready')
  })

  it('inclui campo checks.postgres ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    const body = res.json<{ checks: Record<string, string> }>()
    expect(body.checks['postgres']).toBe('ok')
  })
})

describe('POST /webhook/uazapi', () => {
  let app: FastifyInstance

  beforeAll(async () => { app = await buildApp(); await app.ready() })
  afterAll(async () => { await app.close() })

  it('retorna 200 (sprint 1 — handler real)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/uazapi',
      payload: { test: true },
      headers: { 'content-type': 'application/json' },
    })
    // Sprint 1: handler real retorna 200 sempre (ack pro uazapi)
    expect(res.statusCode).toBe(200)
  })
})
