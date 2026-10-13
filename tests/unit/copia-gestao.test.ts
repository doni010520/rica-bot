/**
 * Cópia para a gestão (13/10/2026): tudo que a Rica manda para a Maria vai
 * também para a Jéssica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const enviados: Array<[string, string, unknown]> = []
vi.mock('../../src/uazapi/client.js', () => ({
  sendWhatsApp: vi.fn(async (p: string, t: string, o: unknown) => { enviados.push([p, t, o]) }),
}))

const { enviarParaGestora, copiasDaGestora } = await import('../../src/routing/gestao.js')
const { EXECUTIVES } = await import('../../src/routing/executives.config.js')

describe('cópia para a gestão', () => {
  beforeEach(() => { enviados.length = 0 })

  it('a Jéssica é a cópia padrão', () => {
    expect(copiasDaGestora()).toEqual(['558199880892'])
  })

  it('manda para a Maria com as opções originais e copia para a Jéssica', async () => {
    await enviarParaGestora('📊 Resumo do dia', { crmSender: null })
    expect(enviados.map(([p]) => p)).toEqual([EXECUTIVES.MARIA_HELENA.phoneFormatted, '558199880892'])
    expect(enviados[1][1]).toBe('📊 Resumo do dia')
  })
})
