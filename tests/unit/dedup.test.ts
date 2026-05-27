/**
 * tests/unit/dedup.test.ts
 * Testes para o dedup Redis — mocka ioredis com store isolado por teste.
 */

import { describe, it, expect, vi } from 'vitest'

describe('shouldNotify()', () => {
  it('primeira chamada retorna true', async () => {
    const store = new Map<string, number>()
    vi.doMock('ioredis', () => ({
      default: vi.fn(() => ({
        incr: (k: string) => { const v = (store.get(k) ?? 0) + 1; store.set(k, v); return Promise.resolve(v) },
        expire: vi.fn().mockResolvedValue(1),
        del: vi.fn(),
        quit: vi.fn(),
        on: vi.fn(),
      })),
    }))
    const { shouldNotify } = await import('../../src/dedup/redis-incr.js')
    const result = await shouldNotify('5511111111', 'GPS')
    expect(result).toBe(true)
    vi.doUnmock('ioredis')
  })

  it('segunda chamada com mesma chave retorna false', async () => {
    // Simula Redis com counter já em 1 (já notificou uma vez)
    vi.doMock('ioredis', () => ({
      default: vi.fn(() => {
        let count = 1 // já foi chamado antes
        return {
          incr: (_k: string) => Promise.resolve(++count),
          expire: vi.fn().mockResolvedValue(1),
          del: vi.fn(),
          quit: vi.fn(),
          on: vi.fn(),
        }
      }),
    }))
    vi.resetModules()
    const { shouldNotify } = await import('../../src/dedup/redis-incr.js')
    const result = await shouldNotify('5522222222', 'padaria')
    expect(result).toBe(false)
    vi.doUnmock('ioredis')
  })

  it('fail-open quando Redis está indisponível', async () => {
    vi.doMock('ioredis', () => ({
      default: vi.fn(() => ({
        incr: vi.fn().mockRejectedValue(new Error('Redis down')),
        on: vi.fn(),
      })),
    }))
    vi.resetModules()
    const { shouldNotify } = await import('../../src/dedup/redis-incr.js')
    const result = await shouldNotify('5533333333', 'erro')
    expect(result).toBe(true) // fail-open
    vi.doUnmock('ioredis')
  })
})
