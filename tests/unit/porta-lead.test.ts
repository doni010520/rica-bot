/**
 * Porta do lead no notificar_equipe: quem não é cliente possível não vira aviso
 * para executivo nem para a Maria (caso Dado, 05/10/2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const avaliar = vi.fn()
vi.mock('../../src/qualificacao/porta-lead.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/qualificacao/porta-lead.js')>()),
  avaliarSeELead: (...a: unknown[]) => avaliar(...a),
}))
vi.mock('../../src/lib/db.js', () => ({ getPool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [] }) })) }))
vi.mock('../../src/memory/postgres-chat.js', () => ({
  loadChatHistory: vi.fn().mockResolvedValue([
    { role: 'human', content: 'Não é padaria, sou mecânico, preciso de 50 mil dólares pra montar a oficina' },
    { role: 'ai', content: 'Entendi!' },
  ]),
}))
const incr = vi.fn()
vi.mock('../../src/dedup/redis-incr.js', () => ({ shouldNotify: (...a: unknown[]) => incr(...a) }))
const alertarBarrado = vi.fn()
vi.mock('../../src/alertas/alertas.js', () => ({ alertarBarrado: (...a: unknown[]) => alertarBarrado(...a) }))
vi.mock('../../src/lib/crm-client.js', () => ({ crmRequest: vi.fn().mockResolvedValue({ success: true }) }))
vi.mock('../../src/followup/executive-followup.js', () => ({ scheduleExecutiveFollowup: vi.fn() }))

const { buildNotificarEquipeTool } = await import('../../src/tools/operations/notificar-equipe.js')
const { respostaNaoELead } = await import('../../src/qualificacao/porta-lead.js')

const params = { nome: 'Dado', telefone: '558186069303', produto: 'Diagnóstico Empresarial', mensagem: 'quer montar oficina' }

describe('notificar_equipe: porta do lead', () => {
  beforeEach(() => {
    avaliar.mockReset()
    incr.mockReset().mockResolvedValue(true)
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') } as Response))
  })

  it('não é cliente possível: não notifica ninguém e manda a Rica não prometer contato', async () => {
    avaliar.mockResolvedValue({ ehLead: false, motivo: 'pede dinheiro e não tem negócio' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await (buildNotificarEquipeTool('558186069303') as any).execute(params, {})
    expect(r).toMatchObject({ success: false, nao_e_lead: true })
    expect(r.message).toMatch(/Não diga que passou os dados/)
    expect(incr).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(alertarBarrado).toHaveBeenCalledWith('558186069303', 'pede dinheiro e não tem negócio')
  })

  it('a avaliação recebe só as falas do lead', async () => {
    avaliar.mockResolvedValue({ ehLead: true, motivo: 'ok' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (buildNotificarEquipeTool('558186069303') as any).execute(params, {})
    const texto = avaliar.mock.calls[0][0] as string
    expect(texto).toContain('LEAD: Não é padaria')
    expect(texto).not.toContain('Entendi!')
    expect(incr).toHaveBeenCalled()
  })

  it('resposta de bloqueio explica o motivo', () => {
    expect(respostaNaoELead('procura emprego').message).toContain('procura emprego')
  })
})
