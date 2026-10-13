/**
 * Mentoria e GPS: o André recebe o lead pela reunião marcada, não pelo aviso
 * solto do notificar_equipe (13/10/2026: "a Rica está transferindo cliente sem
 * agendamento").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let funil: { campanha: string; etapa: string } | null = null
vi.mock('../../src/funil/funil.js', () => ({
  funilAtual: vi.fn(async () => funil),
  ETAPAS_POS_HANDOFF: new Set(['reuniao_agendada', 'transferido']),
}))
vi.mock('../../src/lib/db.js', () => ({ getPool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [] }) })) }))
vi.mock('../../src/memory/postgres-chat.js', () => ({ loadChatHistory: vi.fn().mockResolvedValue([]) }))
const avaliar = vi.fn(async () => ({ ehLead: true, motivo: 'ok' }))
vi.mock('../../src/qualificacao/porta-lead.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/qualificacao/porta-lead.js')>()),
  avaliarSeELead: () => avaliar(),
}))
const incr = vi.fn(async () => true)
vi.mock('../../src/dedup/redis-incr.js', () => ({ shouldNotify: () => incr() }))
vi.mock('../../src/alertas/alertas.js', () => ({ alertarBarrado: vi.fn() }))
vi.mock('../../src/lib/crm-client.js', () => ({ crmRequest: vi.fn().mockResolvedValue({ success: true }) }))
vi.mock('../../src/followup/executive-followup.js', () => ({ scheduleExecutiveFollowup: vi.fn() }))

const { buildNotificarEquipeTool } = await import('../../src/tools/operations/notificar-equipe.js')
const params = { nome: 'Verônica', telefone: '5521969211046', produto: 'Mentoria Padaria Lucrativa', mensagem: 'agradeceu' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chamar = () => (buildNotificarEquipeTool('5521969211046') as any).execute(params, {})

describe('agenda antes do aviso ao André', () => {
  beforeEach(() => {
    incr.mockClear(); avaliar.mockClear()
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') } as Response))
  })

  it('lead da Mentoria sem reunião: nada é enviado e a Rica é mandada para a agenda', async () => {
    funil = { campanha: 'mentoria', etapa: 'engajou' }
    const r = await chamar()
    expect(r).toMatchObject({ success: false, use_agenda: true })
    expect(r.message).toContain('consultar_horarios_andre')
    expect(incr).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('lead do GPS sem reunião: aponta para o link da agenda', async () => {
    funil = { campanha: 'gps', etapa: 'rica_iniciou' }
    expect((await chamar()).message).toContain('enviar_link_agenda_andre')
  })

  it('fora das campanhas com agenda (ou já com reunião), o encaminhamento segue normal', async () => {
    for (const f of [null, { campanha: 'jdl', etapa: 'engajou' }, { campanha: 'mentoria', etapa: 'reuniao_agendada' }]) {
      funil = f
      incr.mockClear()
      const r = await chamar()
      expect(r.use_agenda).toBeUndefined()
      expect(incr).toHaveBeenCalled()
    }
  })
})
