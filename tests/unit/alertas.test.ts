/**
 * Alertas de divergência da Rica para quem monitora (Jéssica, 08/10/2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    set: vi.fn(async (k: string, v: string, ..._o: unknown[]) => { if (store.has(k)) return null; store.set(k, v); return 'OK' }),
    zadd: vi.fn(async (k: string, s: number, m: string) => { const z = (store.get(k) as Map<string, number>) ?? new Map(); z.set(m, s); store.set(k, z) }),
    zremrangebyscore: vi.fn(async (k: string, _a: number, max: number) => { const z = store.get(k) as Map<string, number>; for (const [m, s] of z ?? []) if (s <= max) z.delete(m) }),
    expire: vi.fn(),
    zrange: vi.fn(async (k: string) => [...((store.get(k) as Map<string, number>) ?? new Map()).keys()]),
  })),
}))
const enviados: Array<[string, string]> = []
vi.mock('../../src/uazapi/client.js', () => ({ sendWhatsApp: vi.fn(async (p: string, t: string) => { enviados.push([p, t]) }) }))

const { textoParaVigiar, vigiarPrimeiraMensagem, alertarBarrado, alertarFalha } = await import('../../src/alertas/alertas.js')

const MASTERCLASS = 'Clique no link para acessar o grupo: https://chat.whatsapp.com/CSnoXbhj1aJChiukk'

describe('alertas da Rica', () => {
  beforeEach(() => { store.clear(); enviados.length = 0 })

  it('ignora campanhas conhecidas, cumprimentos e mensagens técnicas', () => {
    expect(textoParaVigiar('Oi, quero saber mais sobre a Mentoria Padaria Lucrativa')).toBeNull()
    expect(textoParaVigiar('Oi, quero saber mais sobre a GPS Padaria')).toBeNull()
    expect(textoParaVigiar('Bom dia')).toBeNull()
    expect(textoParaVigiar('[mensagem de tipo não suportado]')).toBeNull()
    expect(textoParaVigiar(MASTERCLASS)).not.toBeNull()
  })

  it('avalanche: 2º contato novo com a mesma mensagem estranha gera UM alerta para a Jéssica', async () => {
    await vigiarPrimeiraMensagem('5511900000001', MASTERCLASS)
    expect(enviados).toHaveLength(0)
    await vigiarPrimeiraMensagem('5511900000002', MASTERCLASS)
    await vigiarPrimeiraMensagem('5511900000003', MASTERCLASS)
    expect(enviados).toHaveLength(1)
    expect(enviados[0][0]).toBe('558199880892')
    expect(enviados[0][1]).toContain('mensagem fora do comum')
    expect(enviados[0][1]).toContain('chat.whatsapp.com')
  })

  it('o mesmo contato mandando 2 vezes não é avalanche', async () => {
    await vigiarPrimeiraMensagem('5511900000001', MASTERCLASS)
    await vigiarPrimeiraMensagem('5511900000001', MASTERCLASS)
    expect(enviados).toHaveLength(0)
  })

  it('barrado e falha: um alerta por contato, com o link do WhatsApp', async () => {
    await alertarBarrado('558591410734', 'disse que não quer agora')
    await alertarBarrado('558591410734', 'disse que não quer agora')
    await alertarFalha('5511990182036', 'resposta vazia')
    expect(enviados).toHaveLength(2)
    expect(enviados[0][1]).toContain('wa.me/558591410734')
    expect(enviados[0][1]).toContain('disse que não quer agora')
    expect(enviados[1][1]).toContain('falha no atendimento')
  })
})
