/**
 * tests/unit/normalize-phone.test.ts
 * Testes para a função normalizePhone — causa raiz de bugs documentados.
 */

import { describe, it, expect } from 'vitest'
import { normalizePhone, phonesMatch, extractDDD, formatPhoneForSend } from '../../src/uazapi/normalize-phone.js'

describe('normalizePhone()', () => {
  describe('formato uazapi (remoteJid)', () => {
    it('remove @s.whatsapp.net', () => {
      expect(normalizePhone('5511999887766@s.whatsapp.net')).toBe('5511999887766')
    })
    it('remove @c.us', () => {
      expect(normalizePhone('5511999887766@c.us')).toBe('5511999887766')
    })
  })

  describe('números brasileiros', () => {
    it('11 dígitos com DDD → adiciona 55', () => {
      expect(normalizePhone('11999887766')).toBe('5511999887766')
    })
    it('10 dígitos (antigo, sem 9) → adiciona 55', () => {
      expect(normalizePhone('1199887766')).toBe('551199887766')
    })
    it('já tem 55 → mantém', () => {
      expect(normalizePhone('5511999887766')).toBe('5511999887766')
      expect(normalizePhone('5581999000111')).toBe('5581999000111')
    })
    it('não duplica 55', () => {
      const result = normalizePhone('5511999887766')
      expect(result.startsWith('5555')).toBe(false)
    })
    it('formatos com pontuação', () => {
      // 11 dígitos: DDD(2) + 9 + número(8) = '11999887766' → adiciona 55
      expect(normalizePhone('(11) 99988-7766')).toBe('5511999887766')
      expect(normalizePhone('+55 11 99988-7766')).toBe('5511999887766')
    })
  })

  describe('números internacionais (bug documentado: cliente dos EUA)', () => {
    it('número US 11 dígitos → mantém (sem adicionar 55)', () => {
      // +1 (415) 555-1234 → NPA 415 e NXX 555 começam com 2-9 → NANP.
      expect(normalizePhone('14155551234')).toBe('14155551234')
    })

    it('números NANP em formatos variados', () => {
      expect(normalizePhone('+1 (415) 555-1234')).toBe('14155551234')
      expect(normalizePhone('1-212-555-0199')).toBe('12125550199')
      expect(normalizePhone('14155551234@s.whatsapp.net')).toBe('14155551234')
      // Canadá: 604 (Vancouver)
      expect(normalizePhone('16045550123')).toBe('16045550123')
    })

    it('US sem o código de país (10 dígitos) → indistinguível de BR, vira brasileiro', () => {
      // Limitação assumida: 10 dígitos sem DDI é sempre tratado como brasileiro.
      expect(normalizePhone('4155551234')).toBe('554155551234')
    })

    it('número com 12+ dígitos → mantém sem adicionar 55', () => {
      // Ex: número europeu +44 20 7946 0958 → 441279460958 (12 dígitos)
      expect(normalizePhone('441279460958')).toBe('441279460958')
    })
  })

  describe('desambiguação BR × NANP em 11 dígitos', () => {
    it('DDD 11 (São Paulo) → brasileiro (NPA do NANP nunca começa com 1)', () => {
      expect(normalizePhone('11999887766')).toBe('5511999887766')
    })

    it.each(['12', '13', '14', '15', '16', '17', '18', '19'])(
      'DDD %s + celular (9 + 8 dígitos) → brasileiro, não NANP',
      (ddd) => {
        // Esses DDDs passariam no teste de NPA (2-9), mas o 3º dígito "9" do
        // celular brasileiro desempata a favor do caso dominante.
        expect(normalizePhone(`${ddd}988776655`)).toBe(`55${ddd}988776655`)
        expect(normalizePhone(`${ddd}912345678`)).toBe(`55${ddd}912345678`)
      },
    )

    it('prefixo (NXX) começando com 0 ou 1 → não é NANP válido, mantém regra BR', () => {
      // 1 + 555 (NPA ok) + 123 (NXX começa com 1 → inválido no NANP)
      expect(normalizePhone('15551234567')).toBe('5515551234567')
      // 1 + 415 (NPA ok) + 055 (NXX começa com 0 → inválido no NANP)
      expect(normalizePhone('14150551234')).toBe('5514150551234')
    })

    it('10 dígitos começando com 1 → brasileiro (fixo com DDD 1X)', () => {
      expect(normalizePhone('1133334444')).toBe('551133334444')
    })

    it('já com 55 na frente não passa pela heurística NANP', () => {
      expect(normalizePhone('5514155551234')).toBe('5514155551234')
    })
  })

  describe('telefones em formatos típicos de produção', () => {
    it('número RJ com 55 e 9 no celular', () => {
      expect(normalizePhone('5521900000000')).toBe('5521900000000')
    })
    it('número PE sem 55 → adiciona 55', () => {
      expect(normalizePhone('8190000000')).toBe('558190000000')
    })
    it('número PE com 55 → mantém', () => {
      expect(normalizePhone('5581900000000')).toBe('5581900000000')
    })
  })
})

describe('phonesMatch()', () => {
  it('matching com formatos diferentes', () => {
    expect(phonesMatch('5511999887766', '11999887766')).toBe(true)
    expect(phonesMatch('5511999887766@s.whatsapp.net', '5511999887766')).toBe(true)
  })
  it('números diferentes', () => {
    expect(phonesMatch('5511999887766', '5521999887766')).toBe(false)
  })
})

describe('extractDDD()', () => {
  it('extrai DDD de número brasileiro', () => {
    expect(extractDDD('5511999887766')).toBe('11')
    expect(extractDDD('5581988877766')).toBe('81')
    expect(extractDDD('5521900000000')).toBe('21')
  })
  it('retorna null para número internacional', () => {
    // Número com 12 dígitos não começa com 55
    expect(extractDDD('441279460958')).toBeNull()
    // NANP não é mais prefixado com 55, então também não tem DDD
    expect(extractDDD('14155551234')).toBeNull()
  })
})

describe('formatPhoneForSend()', () => {
  it('retorna número normalizado sem formatação', () => {
    expect(formatPhoneForSend('+55 (11) 99988-7766')).toBe('5511999887766')
    expect(formatPhoneForSend('5581900000000')).toBe('5581900000000')
  })
})
