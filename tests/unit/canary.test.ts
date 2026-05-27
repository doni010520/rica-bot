/**
 * tests/unit/canary.test.ts
 * Testes para o canary router — usa funções puras, sem depender de env singleton.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { canaryDecide, phoneHash } from '../../src/canary/router.js'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/index.js'

vi.mock('../../src/buffer/message-buffer.js', () => ({
  getMessageBuffer: () => ({ push: vi.fn(), startWorker: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('../../src/lib/db.js', () => ({
  getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) }),
  checkDbConnection: vi.fn().mockResolvedValue(true),
  closePool: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/lidia/status.js', () => ({
  checkLidiaStatus: vi.fn().mockResolvedValue({ exists: true, lidia: 'ON' }),
  createLeadEntry: vi.fn(), setLidiaStatus: vi.fn(), detectTakeoverCommand: vi.fn().mockReturnValue(null),
}))
vi.mock('../../src/crm/reset-followup.js', () => ({ resetFollowup: vi.fn() }))
vi.mock('../../src/media/processors.js', () => ({ resolveMessageText: vi.fn().mockResolvedValue('') }))
vi.mock('../../src/followup/worker.js', () => ({ startFollowupWorker: vi.fn() }))
vi.mock('../../src/observability/metrics.js', () => ({
  incrementMetric: vi.fn().mockResolvedValue(undefined),
  getAllMetrics: vi.fn().mockResolvedValue({ 'webhook.received': 42 }),
  closeMetrics: vi.fn().mockResolvedValue(undefined),
}))

// ─── lógica pura ──────────────────────────────────────────────────────────────

describe('canaryDecide() — função pura', () => {
  it('0% → sempre n8n', () => {
    expect(canaryDecide('5511999887766', 0)).toBe('n8n')
    expect(canaryDecide('5581988877766', 0)).toBe('n8n')
  })

  it('100% → sempre rica-bot', () => {
    expect(canaryDecide('5511999887766', 100)).toBe('rica-bot')
    expect(canaryDecide('5581988877766', 100)).toBe('rica-bot')
  })

  it('mesmo telefone → decisão determinística', () => {
    const phone = '5581988877766'
    expect(canaryDecide(phone, 50)).toBe(canaryDecide(phone, 50))
    expect(canaryDecide(phone, 25)).toBe(canaryDecide(phone, 25))
  })

  it('50% distribui entre os dois sistemas com telefones variados', () => {
    const phones = Array.from({ length: 20 }, (_, i) => `551199988776${i}`)
    const ricaCount = phones.filter((p) => canaryDecide(p, 50) === 'rica-bot').length
    const n8nCount = phones.filter((p) => canaryDecide(p, 50) === 'n8n').length
    expect(ricaCount).toBeGreaterThan(0)
    expect(n8nCount).toBeGreaterThan(0)
  })
})

describe('phoneHash()', () => {
  it('retorna valor entre 0 e 99', () => {
    const phones = ['5511999887766', '5581988877766', '5521900000000', '5513900000000']
    for (const p of phones) {
      const h = phoneHash(p)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(100)
    }
  })

  it('mesmo telefone → mesmo hash', () => {
    expect(phoneHash('5511999887766')).toBe(phoneHash('5511999887766'))
  })

  it('telefones diferentes → hashes potencialmente diferentes', () => {
    const hashes = new Set(['5511999887761', '5511999887762', '5511999887763', '5511999887764', '5511999887765'].map(phoneHash))
    expect(hashes.size).toBeGreaterThan(1)
  })
})

// ─── endpoints ────────────────────────────────────────────────────────────────

describe('Endpoints Sprint 6', () => {
  let app: FastifyInstance

  beforeAll(async () => { app = await buildApp(); await app.ready() })
  afterAll(async () => { await app.close() })

  it('GET /health inclui info de canary', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = res.json<{ canary: { percentage: number } }>()
    expect(res.statusCode).toBe(200)
    expect(body.canary).toBeDefined()
    expect(typeof body.canary.percentage).toBe('number')
  })

  it('GET /metrics retorna counters', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ counters: Record<string, number> }>()
    expect(body.counters).toBeDefined()
  })

  it('GET /canary retorna status', async () => {
    const res = await app.inject({ method: 'GET', url: '/canary' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ percentage: number; description: string }>()
    expect(typeof body.percentage).toBe('number')
    expect(typeof body.description).toBe('string')
  })
})
