import { describe, it, expect } from 'vitest'
import { buildDedupKey } from '../../src/dedup/redis-incr.js'

describe('buildDedupKey', () => {
  it('acento e maiúscula não criam chave nova (aviso em dobro de 05/10)', () => {
    expect(buildDedupKey('558186069303', 'Diagnóstico Empresarial'))
      .toBe(buildDedupKey('558186069303', 'Diagnostico Empresarial'))
    expect(buildDedupKey('558186069303', ' GPS Resultado ')).toBe(buildDedupKey('558186069303', 'gps resultado'))
  })
  it('produtos diferentes continuam com chaves diferentes', () => {
    expect(buildDedupKey('558186069303', 'Mentoria')).not.toBe(buildDedupKey('558186069303', 'GPS Padaria'))
  })
  it('mantém o formato antigo para produto sem acento', () => {
    expect(buildDedupKey('5511911111111', 'GPS Resultado')).toBe('dedup:notif:11111111:gps_resultado')
  })
})
