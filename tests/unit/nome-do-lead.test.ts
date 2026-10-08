/**
 * Nome do lead (08/10/2026): o André recebia "Nome: Lead WhatsApp" porque o nome
 * do perfil do WhatsApp se perdia no buffer e o contato nascia "Sem nome".
 */
import { describe, it, expect, vi } from 'vitest'

const redis = new Map<string, string | string[]>()
vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    rpush: vi.fn(async (k: string, v: string) => { redis.set(k, [...((redis.get(k) as string[]) ?? []), v]) }),
    expire: vi.fn(),
    set: vi.fn(async (k: string, v: string) => { redis.set(k, v) }),
    get: vi.fn(async (k: string) => (redis.get(k) as string) ?? null),
    lrange: vi.fn(async (k: string) => (redis.get(k) as string[]) ?? []),
    del: vi.fn(async (...ks: string[]) => { ks.forEach((k) => redis.delete(k)) }),
  })),
}))
let processar: ((job: { data: { phone: string } }) => Promise<void>) | undefined
vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({ add: vi.fn(), remove: vi.fn().mockResolvedValue(1) })),
  Worker: vi.fn((_q: string, fn: typeof processar) => { processar = fn; return { on: vi.fn() } }),
}))

const { cleanName } = await import('../../src/crm/pre-fetch.js')
const { getMessageBuffer } = await import('../../src/buffer/message-buffer.js')

describe('nome do lead', () => {
  it('placeholders do CRM e da Rica não contam como nome', () => {
    for (const p of ['Sem nome', 'sem nome', 'Lead WhatsApp', '(desconhecido)']) expect(cleanName(p, '5511990182036')).toBe('')
    expect(cleanName('Maria Silva', '5511990182036')).toBe('Maria Silva')
    expect(cleanName('5511990182036', '5511990182036')).toBe('')
  })

  it('o nome do perfil do WhatsApp atravessa o buffer até o handler', async () => {
    const recebido: unknown[] = []
    const buffer = getMessageBuffer()
    buffer.startWorker(async (m) => { recebido.push(m) })
    await buffer.push('5511990182036', 'Oi, quero saber mais', 'Joana')
    await buffer.push('5511990182036', 'tenho uma padaria')
    await processar!({ data: { phone: '5511990182036' } })
    expect(recebido[0]).toMatchObject({ combinedText: 'Oi, quero saber mais\ntenho uma padaria', displayName: 'Joana' })
  })
})
