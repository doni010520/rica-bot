import { describe, it, expect } from 'vitest'
import { routeToExecutive } from '../../src/routing/executive-router.js'

const route = (produto: string, phone: string, mensagem = '') =>
  routeToExecutive(produto, '', mensagem, phone)

/**
 * Produto novo, pedido pela cliente em 07/09/2026. Duas armadilhas de nome:
 * "padaria" faria cair na regra regional, e "mentoria" faria cair na regra da
 * Maria Helena — que é a mentoria individual de líderes, outro produto.
 */
describe('Mentoria Padaria Lucrativa → André', () => {
  const telefones = [
    ['SP', '5511999887766'],
    ['RJ', '5521999887766'],
    ['MG', '5531999887766'],
    ['PE', '5581999887766'],
    ['RS', '5551999887766'],
  ] as const

  for (const [uf, tel] of telefones) {
    it(`${uf} → André (não cai no roteamento regional de padaria)`, () => {
      expect(route('Mentoria Padaria Lucrativa', tel).executive.name).toBe('André Augusto')
    })
  }

  it('vale mesmo quando a conversa toda fala de padaria', () => {
    const r = route('Mentoria Padaria Lucrativa', '5511999887766', 'tenho uma padaria em SP, quero melhorar o CMV')
    expect(r.executive.name).toBe('André Augusto')
    expect(r.reason).toContain('Mentoria Padaria Lucrativa')
  })

  it('aceita as variações que a Rica pode gravar no produto', () => {
    for (const p of ['padaria lucrativa', 'Mentoria Coletiva', 'mentoria para padaria']) {
      expect(route(p, '5531999887766').executive.name).toBe('André Augusto')
    }
  })
})

describe('a mentoria de líderes continua sendo outra coisa', () => {
  it('"Mentoria" sozinha continua indo para a Maria Helena', () => {
    const r = route('Mentoria', '5511999887766')
    expect(r.executive.name).toBe('Maria Helena')
    expect(r.reason).toContain('Mentoria')
  })

  it('"mentoria individual" e "coaching executivo" não vão para o André', () => {
    expect(route('Mentoria individual', '5521999887766').executive.name).toBe('Maria Helena')
    expect(route('Coaching executivo', '5521999887766').executive.name).toBe('Maria Helena')
  })
})

describe('a regra nova não roubou lead de ninguém', () => {
  it('padaria comum continua indo pelo regional', () => {
    expect(route('Consultoria', '5511999887766', 'tenho uma padaria').executive.name).toBe('Alex Araújo')
    expect(route('Consultoria', '5581999887766', 'tenho uma padaria').executive.name).toBe('Gabriela Câmara')
    expect(route('Consultoria', '5531999887766', 'tenho uma padaria').executive.name).toBe('Lúcia Carcerere')
  })

  it('GPS continua indo para o André pela regra do GPS', () => {
    const r = route('GPS Padaria', '5531999887766')
    expect(r.executive.name).toBe('André Augusto')
    expect(r.reason).toContain('GPS')
  })
})
