/**
 * tests/unit/executive-router.test.ts
 * Testes do roteamento de executivos — assinatura corrigida (produto, empresa, mensagem, phone).
 */

import { describe, it, expect } from 'vitest'
import { routeToExecutive } from '../../src/routing/executive-router.js'
import { mapDDDToRegion } from '../../src/routing/region-mapper.js'

// Helper: chama com empresa e mensagem vazias (caso mais comum)
const route = (produto: string, phone: string, empresa = '', mensagem = '') =>
  routeToExecutive(produto, empresa, mensagem, phone)

describe('routeToExecutive()', () => {
  describe('Prioridade 1 — Treinamentos/PDL → Vanessa', () => {
    it('treinamento', () => expect(route('Treinamento de Líderes', '5511999887766').executive.name).toBe('Vanessa Souza'))
    it('PDL', () => expect(route('PDL corporativo', '5511999887766').executive.name).toBe('Vanessa Souza'))
    it('programa de desenvolvimento', () => expect(route('Programa de Desenvolvimento', '5511999887766').executive.name).toBe('Vanessa Souza'))
    it('PDL tem prioridade sobre GPS', () => expect(route('GPS + PDL', '5511999887766').executive.name).toBe('Vanessa Souza'))
  })

  describe('Prioridade 2 — Eneagrama → Lúcia', () => {
    it('eneagrama', () => expect(route('Eneagrama corporativo', '5511999887766').executive.name).toBe('Lúcia Carcerere'))
    it('autoconhecimento', () => expect(route('autoconhecimento', '5511999887766').executive.name).toBe('Lúcia Carcerere'))
  })

  // A Patrícia saiu da empresa em 31/08/2026. Ela atendia GPS de RJ e MG; a
  // gestora pediu que esses leads passassem para o André, que já tinha o resto.
  describe('GPS → André em todo o Brasil', () => {
    it('SP → André', () => expect(route('GPS Resultado', '5511999887766').executive.name).toBe('André Augusto'))
    it('PE → André', () => expect(route('GPS Resultado', '5581999887766').executive.name).toBe('André Augusto'))
    it('RJ → André', () => expect(route('GPS Resultado', '5521999887766').executive.name).toBe('André Augusto'))
    it('MG → André', () => expect(route('GPS Resultado', '5531999887766').executive.name).toBe('André Augusto'))
    it('nenhum GPS cai mais na Patrícia', () => {
      for (const tel of ['5511999887766', '5521999887766', '5531999887766', '5581999887766', '5571999887766']) {
        expect(route('GPS Padaria', tel).executive.name).not.toBe('Patrícia Alves')
      }
    })
  })

  describe('Alexy — catch-all nacional → Alex (sem regional)', () => {
    it('Alexy de SP → Alex', () => expect(route('Alexy', '5511999887766').executive.name).toBe('Alex Araújo'))
    it('Alexy de nordeste → Alex (não Gabriela)', () => expect(route('Alexy', '5581999887766').executive.name).toBe('Alex Araújo'))
    it('Alexy de RJ → Alex (não Lúcia)', () => expect(route('Alexy', '5521999887766').executive.name).toBe('Alex Araújo'))
  })

  describe('Padaria (regional)', () => {
    it('SP → Alex', () => expect(route('padaria artesanal', '5511999887766').executive.name).toBe('Alex Araújo'))
    it('MG → Lúcia', () => expect(route('padaria', '5531999887766').executive.name).toBe('Lúcia Carcerere'))
    it('ES → Alex', () => expect(route('padaria', '5527999887766').executive.name).toBe('Alex Araújo'))
    it('PE → Gabriela', () => expect(route('padaria', '5581999887766').executive.name).toBe('Gabriela Câmara'))
    it('PA (norte) → Gabriela', () => expect(route('padaria', '5591999887766').executive.name).toBe('Gabriela Câmara'))
    it('RJ → Lúcia', () => expect(route('padaria', '5521999887766').executive.name).toBe('Lúcia Carcerere'))
    it('PR (sul) → Lúcia', () => expect(route('padaria', '5541999887766').executive.name).toBe('Lúcia Carcerere'))
    it('GO → Carolina', () => expect(route('padaria', '5562999887766').executive.name).toBe('Carolina Câmara'))
    it('detecta na empresa', () => expect(route('Diagnóstico', '5511999887766', 'Panificadora Três Irmãs').executive.name).toBe('Alex Araújo'))
    it('detecta na mensagem', () => expect(route('Diagnóstico', '5581999887766', '', 'tenho uma padaria').executive.name).toBe('Gabriela Câmara'))
  })

  describe('Supermercado → Irelene', () => {
    it('supermercado', () => expect(route('supermercado', '5511999887766').executive.name).toBe('Irelene Guerreiro'))
    it('mercado', () => expect(route('mercado', '5511999887766').executive.name).toBe('Irelene Guerreiro'))
    it('atacarejo', () => expect(route('atacarejo', '5511999887766').executive.name).toBe('Irelene Guerreiro'))
  })

  // Ana Clara saiu da empresa em 27/08/2026 -- cafeteria passou para a Gabriela.
  describe('Cafeteria → Gabriela', () => {
    it('cafeteria', () => expect(route('cafeteria', '5511999887766').executive.name).toBe('Gabriela Câmara'))
    it('coffee', () => expect(route('coffee shop', '5511999887766').executive.name).toBe('Gabriela Câmara'))
    it('nunca mais vai para Ana Clara', () =>
      expect(route('cafeteria gourmet', '5511999887766').executive.name).not.toBe('Ana Clara'))
  })

  // Helen Monte saiu do direcionamento em 27/08/2026 -- passou para a Maria Helena.
  describe('MKT/Planejamento/Mentoria → Maria Helena', () => {
    it('marketing', () => expect(route('marketing digital', '5511999887766').executive.name).toBe('Maria Helena'))
    it('mkt', () => expect(route('mkt', '5511999887766').executive.name).toBe('Maria Helena'))
    it('mentoria', () => expect(route('mentoria empresarial', '5511999887766').executive.name).toBe('Maria Helena'))
    it('planejamento estratégico', () => expect(route('planejamento estratégico', '5511999887766').executive.name).toBe('Maria Helena'))
    it('planejamento comercial', () => expect(route('planejamento comercial', '5511999887766').executive.name).toBe('Maria Helena'))
    it('nenhum produto cai mais na Helen', () => {
      for (const p of ['marketing digital', 'mkt', 'mentoria empresarial', 'planejamento estratégico']) {
        expect(route(p, '5511999887766').executive.name).not.toBe('Helen Monte')
      }
    })
  })

  describe('Fallback → 100% Maria Helena (sem hash)', () => {
    it('consultoria genérica → Maria Helena', () => expect(route('consultoria', '5511999887766').executive.name).toBe('Maria Helena'))
    it('diagnóstico genérico → Maria Helena', () => expect(route('diagnóstico empresarial', '5511999887766').executive.name).toBe('Maria Helena'))
    // Garante que o fallback não vaza para quem saiu do direcionamento
    it('produto desconhecido → Maria Helena, não Helen', () => {
      const telefones = ['5511999887761', '5511999887762', '5511999887763', '5511999887764', '5511999887765']
      for (const tel of telefones) {
        expect(route('produto desconhecido xyz', tel).executive.name).toBe('Maria Helena')
      }
    })
  })

  describe('Irelene resolve a partir da env var', () => {
    it('Irelene resolve a partir de EXEC_IRELENE_PHONE', () => {
      const r = route('supermercado', '5511999887766')
      const expected = process.env['EXEC_IRELENE_PHONE'] ?? ''
      expect(r.executive.phoneFormatted).toBe(expected)
      expect(r.executive.phone).toBe(expected.replace(/^55/, ''))
    })
  })
})

describe('mapDDDToRegion()', () => {
  it('DDD 11 → SP', () => { const r = mapDDDToRegion('5511999887766'); expect(r.state).toBe('SP'); expect(r.ddd).toBe(11) })
  it('DDD 81 → PE', () => { const r = mapDDDToRegion('5581999887766'); expect(r.state).toBe('PE') })
  it('DDD 21 → RJ', () => { const r = mapDDDToRegion('5521999887766'); expect(r.subregion).toBe('rio_de_janeiro') })
  it('número inválido → nao_identificada', () => { const r = mapDDDToRegion('abc'); expect(r.region).toBe('nao_identificada') })
})
