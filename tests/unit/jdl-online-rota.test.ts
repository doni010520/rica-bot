import { describe, it, expect } from 'vitest'
import { routeToExecutive } from '../../src/routing/executive-router.js'

const route = (produto: string, phone: string, mensagem = '') =>
  routeToExecutive(produto, '', mensagem, phone)

/**
 * 07/09/2026: um lead disse "Sim, quero o link" da Jornada Online. A Rica
 * encaminhou com produto="JDL Online", nenhuma regra casou, e ele caiu no
 * fallback — foi parar na Maria Helena, que teve que mandar o link na mão.
 *
 * O prompt manda vender direto e, se precisar transferir, usar o André. Esta
 * regra é a rede de proteção: se a Rica errar a ferramenta, o lead chega certo.
 */
describe('JDL Online → André', () => {
  it('o produto exato que a Rica gravou no dia do erro', () => {
    const r = route('JDL Online', '5521998433364')
    expect(r.executive.name).toBe('André Augusto')
    expect(r.reason).toContain('JDL')
  })

  it('não cai mais no fallback da Maria Helena', () => {
    for (const p of ['JDL Online', 'Jornada da Lucratividade Online', 'jornada online', 'JDL']) {
      expect(route(p, '5521998433364').executive.name).not.toBe('Maria Helena')
    }
  })

  it('vence a regra regional de padaria, que pegaria primeiro', () => {
    // A conversa de um lead de JDL quase sempre fala de padaria; sem a ordem
    // certa, este lead de SP iria para o Alex.
    const r = route('JDL Online', '5511999887766', 'tenho uma padaria e quero melhorar o CMV')
    expect(r.executive.name).toBe('André Augusto')
  })

  it('vale em qualquer estado', () => {
    for (const tel of ['5511999887766', '5521999887766', '5531999887766', '5581999887766']) {
      expect(route('JDL Online', tel).executive.name).toBe('André Augusto')
    }
  })
})

describe('a regra do JDL não roubou lead de ninguém', () => {
  it('padaria comum continua no roteamento regional', () => {
    expect(route('Consultoria', '5511999887766', 'tenho uma padaria').executive.name).toBe('Alex Araújo')
    expect(route('Consultoria', '5581999887766', 'tenho uma padaria').executive.name).toBe('Gabriela Câmara')
  })

  it('GPS e Mentoria Padaria Lucrativa continuam com o André pelas regras delas', () => {
    expect(route('GPS Padaria', '5531999887766').reason).toContain('GPS')
    expect(route('Mentoria Padaria Lucrativa', '5531999887766').reason).toContain('Mentoria Padaria Lucrativa')
  })

  it('quem não é de produto nenhum continua caindo na Maria Helena', () => {
    expect(route('Assunto qualquer', '5511999887766').executive.name).toBe('Maria Helena')
  })
})
