import { describe, it, expect } from 'vitest'
import { executivosDaMentoria, executivoDoLead, proximoDaRoda } from '../../src/funil/divisao-mentoria.js'
import { EXECUTIVES } from '../../src/routing/executives.config.js'

const raquel = { phone: '5581900000000', email: 'raquel@teste.com' }

describe('divisão da Mentoria (André x Raquel)', () => {
  it('sem telefone da Raquel, só o André', () => {
    expect(executivosDaMentoria({}).map((e) => e.name)).toEqual([EXECUTIVES.ANDRE.name])
  })
  it('alterna: depois do André vem a Raquel e vice-versa', () => {
    const lista = executivosDaMentoria(raquel)
    expect(proximoDaRoda(EXECUTIVES.ANDRE.email, lista).name).toBe('Raquel')
    expect(proximoDaRoda('RAQUEL@teste.com', lista).name).toBe(EXECUTIVES.ANDRE.name)
    expect(proximoDaRoda(null, lista).name).toBe(EXECUTIVES.ANDRE.name)
  })
  it('lead da Raquel continua dela; e-mail fora da roda volta pro André', () => {
    const lista = executivosDaMentoria(raquel)
    expect(executivoDoLead({ executivo_email: 'raquel@teste.com' }, lista).phoneFormatted).toBe('5581900000000')
    expect(executivoDoLead({ executivo_email: 'raquel@teste.com' }, executivosDaMentoria({})).name).toBe(EXECUTIVES.ANDRE.name)
    expect(executivoDoLead(null, lista).name).toBe(EXECUTIVES.ANDRE.name)
  })
})
