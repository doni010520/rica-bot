/**
 * tests/unit/notificar-equipe.test.ts
 *
 * Testes da tool mais crítica do sistema.
 * Cobre: dedup, roteamento por produto, cópia para Maria Helena, assign-owner.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

// ─── mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Dedup: primeiro INCR = 1 (permite), segundo = 2 (bloqueia)
const incrValues: Record<string, number> = {}
vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    incr: vi.fn().mockImplementation((key: string) => {
      incrValues[key] = (incrValues[key] ?? 0) + 1
      return Promise.resolve(incrValues[key])
    }),
    expire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
  })),
}))

// CRM request
vi.mock('../../src/lib/crm-client.js', () => ({
  crmRequest: vi.fn().mockResolvedValue({ success: true }),
}))

function makeOkResponse() {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') } as Response)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function callNotificar(overrides: {
  produto?: string
  empresa?: string
  mensagem?: string
  telefone?: string
}) {
  // Reset incrValues para cada chamada com telefone diferente
  const { buildNotificarEquipeTool } = await import('../../src/tools/operations/notificar-equipe.js')
  const tool = buildNotificarEquipeTool('5511999887766')
  return tool.execute({
    nome: 'João Silva',
    telefone: overrides.telefone ?? '5511999887766',
    produto: overrides.produto ?? 'Diagnóstico Empresarial',
    mensagem: overrides.mensagem ?? 'Quero saber mais',
    empresa: overrides.empresa ?? '',
    email: 'joao@empresa.com',
    deal_id: 'd1',
  })
}

// ─── testes ───────────────────────────────────────────────────────────────────

describe('notificar_equipe tool', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockReturnValue(makeOkResponse())
    // Limpa o módulo para resetar o dedup singleton
    vi.resetModules()
    // Limpa os contadores de INCR
    for (const k in incrValues) delete incrValues[k]
  })

  describe('dedup Redis', () => {
    it('primeira notificação é enviada', async () => {
      const result = await callNotificar({ produto: 'GPS Resultado', telefone: '5511111111111' })
      expect(result.success).toBe(true)
      expect(result.deduplicated).toBe(false)
    })

    it('segunda notificação com mesmo telefone+produto é bloqueada', async () => {
      // Segunda chamada: INCR já retorna 2
      incrValues['dedup:notif:11111111:gps_resultado'] = 1 // simula já ter sido chamado
      const result = await callNotificar({ produto: 'GPS Resultado', telefone: '5511111111111' })
      expect(result.deduplicated).toBe(true)
      // Não deve ter chamado fetch para WhatsApp
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('roteamento correto por produto', () => {
    const cases: Array<{ produto: string; empresa?: string; telefone: string; expected: string }> = [
      { produto: 'GPS Resultado', telefone: '5511999887766', expected: 'André Augusto' },
      { produto: 'Alexy', telefone: '5581999887766', expected: 'Alex Araújo' }, // Alexy catch-all
      { produto: 'padaria artesanal SP', telefone: '5511999887766', expected: 'Alex Araújo' }, // padaria SP
      { produto: 'GPS Padaria', telefone: '5581999887766', expected: 'André Augusto' }, // GPS wins over padaria
      { produto: 'panificadora', telefone: '5581999887766', expected: 'Gabriela Câmara' }, // padaria nordeste
      { produto: 'Diagnóstico supermercado', telefone: '5511999887766', expected: 'Irelene Guerreiro' },
      { produto: 'Cafeteria gourmet', telefone: '5511999887766', expected: 'Ana Clara' },
      { produto: 'Treinamento de líderes', telefone: '5511999887766', expected: 'Vanessa Souza' },
      { produto: 'PDL para equipes', telefone: '5511999887766', expected: 'Vanessa Souza' },
      { produto: 'Eneagrama corporativo', telefone: '5511999887766', expected: 'Lúcia Carcerere' },
      { produto: 'Mentoria empresarial', telefone: '5511999887766', expected: 'Helen Monte' },
      { produto: 'Marketing digital', telefone: '5511999887766', expected: 'Helen Monte' },
      { produto: 'Consultoria geral', telefone: '5511999887766', expected: 'Maria Helena' }, // fallback
    ]

    for (const { produto, telefone, expected } of cases) {
      it(`"${produto}" → ${expected}`, async () => {
        const { buildNotificarEquipeTool } = await import('../../src/tools/operations/notificar-equipe.js')
        const tool = buildNotificarEquipeTool('5500000000000')
        const result = await tool.execute({
          nome: 'Teste',
          telefone,
          produto,
          mensagem: 'interesse',
          empresa: '',
          deal_id: 'd1',
        })
        expect(result.success).toBe(true)
        expect(result.executive).toBe(expected)
      })
    }
  })

  describe('detecção de segmento por empresa/mensagem', () => {
    it('padaria detectada na mensagem mesmo com produto genérico', async () => {
      const { buildNotificarEquipeTool } = await import('../../src/tools/operations/notificar-equipe.js')
      const tool = buildNotificarEquipeTool('5500000000001')
      const result = await tool.execute({
        nome: 'Maria',
        telefone: '5511999887700',
        produto: 'Diagnóstico Empresarial',
        mensagem: 'tenho uma panificadora em SP',
        empresa: '',
        deal_id: 'd2',
      })
      expect(result.executive).toBe('Alex Araújo') // padaria SP → Alex
    })

    it('supermercado detectado na empresa', async () => {
      const { buildNotificarEquipeTool } = await import('../../src/tools/operations/notificar-equipe.js')
      const tool = buildNotificarEquipeTool('5500000000002')
      const result = await tool.execute({
        nome: 'Pedro',
        telefone: '5511999887701',
        produto: 'GPS Resultado',
        mensagem: 'quero contratar',
        empresa: 'Supermercado Bom Preço',
        deal_id: 'd3',
      })
      // GPS tem prioridade sobre supermercado na empresa — essa é a regra atual
      expect(result.executive).toBe('André Augusto')
    })
  })

  describe('envio de notificações', () => {
    it('envia WhatsApp para executivo E para Maria Helena', async () => {
      await callNotificar({ produto: 'Consultoria', telefone: '5511999887799' })
      // Deve ter feito pelo menos 2 chamadas fetch (executivo + gestora)
      // + 1 para CRM assign-owner + 1 para atividade = 4 total
      const wappCalls = (mockFetch as Mock).mock.calls.filter(
        (c) => String(c[0]).includes('/send/text')
      )
      expect(wappCalls.length).toBeGreaterThanOrEqual(2)
    })

    it('segundo WhatsApp é para Maria Helena (gestora)', async () => {
      await callNotificar({ produto: 'Consultoria', telefone: '5511999887788' })
      const wappCalls = (mockFetch as Mock).mock.calls
        .filter((c) => String(c[0]).includes('/send/text'))
        .map((c) => JSON.parse(c[1].body as string) as { number: string })
      const phones = wappCalls.map((b) => b.number)
      // Maria Helena vem da env var EXEC_MARIA_HELENA_PHONE (em tests/setup.ts)
      const expectedMariaHelena = process.env['EXEC_MARIA_HELENA_PHONE'] ?? ''
      expect(phones).toContain(expectedMariaHelena)
    })

    it('chama assign-owner-by-phone no CRM', async () => {
      const { crmRequest } = await import('../../src/lib/crm-client.js')
      await callNotificar({ produto: 'GPS', telefone: '5511999887777' })
      expect(crmRequest).toHaveBeenCalledWith(
        '/api/crm/deals/assign-owner-by-phone',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('payload usa number/text/delay (não phone/message)', async () => {
      await callNotificar({ produto: 'Consultoria', telefone: '5511999887766' })
      const wappCall = (mockFetch as Mock).mock.calls.find((c) =>
        String(c[0]).includes('/send/text'),
      )
      expect(wappCall).toBeDefined()
      const body = JSON.parse(wappCall![1].body as string) as Record<string, unknown>
      expect(body).toHaveProperty('number')
      expect(body).toHaveProperty('text')
      expect(body).toHaveProperty('delay', '3000')
      expect(body).not.toHaveProperty('phone')
      expect(body).not.toHaveProperty('message')
    })
  })
})
