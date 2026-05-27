/**
 * tests/unit/crm-tools.test.ts
 * Testes para as 14 tools CRM — mocka fetch para não depender de infra.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildCrmTools } from '../../src/tools/crm/definitions.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeOkResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response)
}

function makeErrorResponse(status: number) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'test error' }),
    text: () => Promise.resolve('error'),
  } as Response)
}

const PHONE = '5511999887766'

describe('buildCrmTools()', () => {
  let tools: ReturnType<typeof buildCrmTools>

  beforeEach(() => {
    mockFetch.mockReset()
    tools = buildCrmTools(PHONE)
  })

  describe('buscar_contato', () => {
    it('chama GET /contacts/by-phone com o telefone correto', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ contact: { id: 'c1' } }))
      const result = await tools.buscar_contato.execute({ phone_override: undefined })
      expect(result.success).toBe(true)
      const url = mockFetch.mock.calls[0]?.[0] as string
      expect(url).toContain('/contacts/by-phone/')
      expect(url).toContain(PHONE)
    })

    it('retorna success=false quando CRM retorna erro', async () => {
      mockFetch.mockReturnValueOnce(makeErrorResponse(500))
      const result = await tools.buscar_contato.execute({ phone_override: undefined })
      expect(result.success).toBe(false)
    })

    it('usa phone_override quando fornecido', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ contact: null }))
      await tools.buscar_contato.execute({ phone_override: '5521999887766' })
      const url = mockFetch.mock.calls[0]?.[0] as string
      expect(url).toContain('5521999887766')
    })
  })

  describe('registrar_lead', () => {
    it('chama POST /register-lead com phone da conversa por padrão', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ contact: { id: 'c1' }, deal: { id: 'd1' } }))
      await tools.registrar_lead.execute({
        contact_name: 'João Silva',
        pipeline_name: 'Triagem',
        source: 'whatsapp',
        temperature: 'warm',
      })
      const call = mockFetch.mock.calls[0]
      expect(call?.[0]).toContain('/register-lead')
      const body = JSON.parse(call?.[1]?.body as string)
      expect(body.contact_phone).toBe(PHONE)
      expect(body.contact_name).toBe('João Silva')
    })
  })

  describe('atualizar_lead', () => {
    it('chama PATCH /deals/:id', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ id: 'd1', temperature: 'hot' }))
      const result = await tools.atualizar_lead.execute({
        deal_id: 'd1',
        temperature: 'hot',
      })
      expect(result.success).toBe(true)
      const url = mockFetch.mock.calls[0]?.[0] as string
      expect(url).toContain('/deals/d1')
      const opts = mockFetch.mock.calls[0]?.[1]
      expect(opts?.method).toBe('PATCH')
    })
  })

  describe('salvar_insight', () => {
    it('chama POST /deals/:id/insights com source=ai_agent', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ id: 'i1' }))
      await tools.salvar_insight.execute({
        deal_id: 'd1',
        category: 'segmento',
        content: 'cliente tem padaria',
        confidence: 0.95,
      })
      const url = mockFetch.mock.calls[0]?.[0] as string
      expect(url).toContain('/deals/d1/insights')
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string)
      expect(body.source).toBe('ai_agent')
      expect(body.category).toBe('segmento')
    })
  })

  describe('mover_estagio', () => {
    it('chama PATCH /deals/:id/stage', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ id: 'd1' }))
      await tools.mover_estagio.execute({ deal_id: 'd1', stage_id: 's2' })
      const url = mockFetch.mock.calls[0]?.[0] as string
      expect(url).toContain('/deals/d1/stage')
      const opts = mockFetch.mock.calls[0]?.[1]
      expect(opts?.method).toBe('PATCH')
    })
  })

  describe('consultar_cnpj', () => {
    it('remove não-dígitos do CNPJ antes de chamar', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ razao_social: 'Empresa X' }))
      await tools.consultar_cnpj.execute({ cnpj: '12.345.678/0001-90' })
      const url = mockFetch.mock.calls[0]?.[0] as string
      // Verifica que apenas dígitos chegaram no path do CNPJ
      expect(url).toContain('/cnpj/12345678000190')
      // Não deve ter separadores do CNPJ original
      expect(url).not.toContain('12.345')
      expect(url).not.toContain('0001-90')
    })
  })

  describe('salvar_insights_lote', () => {
    it('envia array de insights com source=ai_agent', async () => {
      mockFetch.mockReturnValueOnce(makeOkResponse({ inserted: 2 }))
      await tools.salvar_insights_lote.execute({
        deal_id: 'd1',
        insights: [
          { category: 'segmento', content: 'padaria', confidence: 0.9 },
          { category: 'produto', content: 'GPS Resultado', confidence: 0.8 },
        ],
      })
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string)
      expect(body.insights).toHaveLength(2)
      expect(body.insights[0].source).toBe('ai_agent')
    })
  })
})
