import { describe, it, expect } from 'vitest'
import { destinoDaCobranca } from '../../src/followup/executive-followup.js'
import { EXECUTIVES } from '../../src/routing/executives.config.js'

/**
 * A cobrança de 24h é agendada com o executivo congelado no payload do job.
 * Em 01/09/2026 a Patrícia recebeu duas cobranças de leads encaminhados no dia
 * anterior — o roteamento já estava corrigido, mas os jobs que dormiam no Redis
 * ainda apontavam para ela.
 */
describe('destinoDaCobranca', () => {
  it('cobrança agendada para a Patrícia vai para o André', () => {
    const d = destinoDaCobranca('Patrícia Alves', EXECUTIVES.PATRICIA.phoneFormatted)
    expect(d.name).toBe('André Augusto')
    expect(d.phone).toBe(EXECUTIVES.ANDRE.phoneFormatted)
    expect(d.phone).not.toBe(EXECUTIVES.PATRICIA.phoneFormatted)
  })

  it('vale para todos que saíram da empresa', () => {
    expect(destinoDaCobranca('Helen Monte', EXECUTIVES.HELEN.phoneFormatted).name).toBe('Maria Helena')
    expect(destinoDaCobranca('Ana Clara', EXECUTIVES.ANA_CLARA.phoneFormatted).name).toBe('Gabriela Câmara')
  })

  it('quem continua na empresa recebe a própria cobrança', () => {
    const d = destinoDaCobranca('André Augusto', EXECUTIVES.ANDRE.phoneFormatted)
    expect(d.name).toBe('André Augusto')
    expect(d.phone).toBe(EXECUTIVES.ANDRE.phoneFormatted)
  })

  it('nome desconhecido mantém o telefone agendado, em vez de não cobrar ninguém', () => {
    const d = destinoDaCobranca('Fulano de Tal', '5511999999999')
    expect(d.name).toBe('Fulano de Tal')
    expect(d.phone).toBe('5511999999999')
  })
})
