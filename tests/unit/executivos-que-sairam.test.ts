import { describe, it, expect } from 'vitest'
import { resolveExecutiveByName } from '../../src/routing/executives.config.js'

// Helen (27/08), Ana Clara (27/08) e Patricia (31/08) sairam da empresa. Pedir
// o nome delas tem que entregar o lead ao sucessor, nunca a elas.
describe('quem saiu da empresa nao recebe mais lead pelo nome', () => {
  const casos: [string, string][] = [
    ['Helen', 'Maria Helena'],
    ['helen monte', 'Maria Helena'],
    ['Ana Clara', 'Gabriela Câmara'],
    ['Patrícia', 'André Augusto'],
    ['patricia alves', 'André Augusto'],
    ['Patrícia Alves', 'André Augusto'],
  ]
  for (const [pedido, sucessor] of casos) {
    it(`"${pedido}" → ${sucessor}`, () =>
      expect(resolveExecutiveByName(pedido)?.name).toBe(sucessor))
  }
  it('quem ficou continua resolvendo normalmente', () => {
    expect(resolveExecutiveByName('André')?.name).toBe('André Augusto')
    expect(resolveExecutiveByName('Maria Helena')?.name).toBe('Maria Helena')
    expect(resolveExecutiveByName('Gabriela')?.name).toBe('Gabriela Câmara')
  })
})
