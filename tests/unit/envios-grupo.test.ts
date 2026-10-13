/**
 * Envios agendados em grupo (régua da Masterclass, 14/10/2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const enviados: Array<[string, unknown]> = []
vi.mock('../../src/uazapi/client.js', () => ({ sendToGroup: vi.fn(async (j: string, p: unknown) => { enviados.push([j, p]) }) }))
const alertas: string[] = []
vi.mock('../../src/alertas/alertas.js', () => ({ alertarEnvioGrupo: vi.fn(async (_i: number, d: string) => { alertas.push(d) }) }))

const { processarEnviosVencidos } = await import('../../src/grupos/envios-agendados.js')

function poolCom(vencidos: Array<{ id: number; enviar_em: Date; midia_url?: string | null }>) {
  const updates: Array<[string, unknown[]]> = []
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("SET status = 'enviando'")) {
        return { rows: vencidos.map((v) => ({ grupo_jid: '120363000@g.us', texto: 'É amanhã!', descricao: 'D-1', midia_url: null, ...v })) }
      }
      updates.push([sql, params]); return { rows: [] }
    }),
  }
  return { pool, updates }
}

describe('envios agendados em grupo', () => {
  beforeEach(() => { enviados.length = 0; alertas.length = 0 })

  it('envia o que venceu e marca como enviado', async () => {
    const { pool, updates } = poolCom([{ id: 1, enviar_em: new Date(Date.now() - 60_000), midia_url: 'https://x/card.jpg' }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processarEnviosVencidos(pool as any)
    expect(enviados).toEqual([['120363000@g.us', { texto: 'É amanhã!', midiaUrl: 'https://x/card.jpg' }]])
    expect(updates.some(([s]) => s.includes("status = 'enviado'"))).toBe(true)
  })

  it('vencido há mais de 90 min não sai e gera alerta', async () => {
    const { pool, updates } = poolCom([{ id: 2, enviar_em: new Date(Date.now() - 3 * 3600_000) }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processarEnviosVencidos(pool as any)
    expect(enviados).toHaveLength(0)
    expect(updates.some(([s]) => s.includes("status = 'atrasado'"))).toBe(true)
    expect(alertas[0]).toContain('não saiu')
  })
})
