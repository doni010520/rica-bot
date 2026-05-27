/**
 * tests/unit/timezone.test.ts
 *
 * Testes para src/lib/timezone.ts
 *
 * Cobertura:
 *   - nowBrasilia() retorna objeto com todos os campos
 *   - toBrasilia() formata datas corretamente no fuso BRT
 *   - isBusinessHour() detecta horário comercial e fins de semana
 *   - ISO offset é -03:00 (BRT) ou -02:00 (BRST) — nunca UTC
 */

import { describe, it, expect } from 'vitest'
import { nowBrasilia, toBrasilia, isBusinessHour, nowISO, sleep } from '../../src/lib/timezone.js'

describe('timezone.ts', () => {
  describe('nowBrasilia()', () => {
    it('retorna objeto com todos os campos esperados', () => {
      const now = nowBrasilia()

      expect(now).toHaveProperty('date')
      expect(now).toHaveProperty('iso')
      expect(now).toHaveProperty('ts')
      expect(now).toHaveProperty('long')
      expect(now).toHaveProperty('short')
      expect(now).toHaveProperty('time')
      expect(now).toHaveProperty('dateStr')
    })

    it('ts é um timestamp válido', () => {
      const now = nowBrasilia()
      expect(now.ts).toBeGreaterThan(0)
      expect(typeof now.ts).toBe('number')
    })

    it('iso contém offset de fuso (não é Z/UTC puro)', () => {
      const now = nowBrasilia()
      // ISO deve ter +HH:MM ou -HH:MM, nunca Z
      expect(now.iso).not.toMatch(/Z$/)
      expect(now.iso).toMatch(/[+-]\d{2}:\d{2}$/)
    })
  })

  describe('toBrasilia()', () => {
    it('formata data conhecida corretamente', () => {
      // UTC 17:00 = BRT 14:00 (UTC-3)
      const utcDate = new Date('2026-05-22T17:00:00.000Z')
      const brt = toBrasilia(utcDate)

      // Hora deve ser 14:xx em BRT
      expect(brt.time).toBe('14:00')
      // Data deve ser 22/05/2026
      expect(brt.dateStr).toBe('22/05/2026')
    })

    it('short tem formato DD/MM/YYYY HH:MM', () => {
      const utcDate = new Date('2026-05-22T17:30:00.000Z')
      const brt = toBrasilia(utcDate)
      // Deve conter data e hora
      expect(brt.short).toMatch(/\d{2}\/\d{2}\/\d{4}/)
      expect(brt.short).toContain('14:30')
    })

    it('long contém o nome do dia da semana em português', () => {
      // 2026-05-22 é sexta-feira
      const utcDate = new Date('2026-05-22T12:00:00.000Z')
      const brt = toBrasilia(utcDate)
      expect(brt.long.toLowerCase()).toContain('sexta')
    })

    it('iso tem offset -03:00 para horário de Brasília padrão', () => {
      // BRT é UTC-3 (sem DST desde 2019)
      const utcDate = new Date('2026-07-15T15:00:00.000Z')
      const brt = toBrasilia(utcDate)
      expect(brt.iso).toContain('-03:00')
    })

    it('não usa Z (UTC) no iso — bug do n8n resolvido', () => {
      const dates = [
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-06-15T12:00:00.000Z'),
        new Date('2026-12-31T23:59:59.000Z'),
      ]
      for (const date of dates) {
        const brt = toBrasilia(date)
        expect(brt.iso).not.toMatch(/Z$/)
        expect(brt.iso).not.toMatch(/\+00:00$/)
      }
    })
  })

  describe('isBusinessHour()', () => {
    it('retorna true em dia útil dentro do horário', () => {
      // Sexta-feira 22/05/2026 às 14:00 BRT = 17:00 UTC
      const friday14h = new Date('2026-05-22T17:00:00.000Z')
      expect(isBusinessHour(friday14h)).toBe(true)
    })

    it('retorna false antes do horário comercial', () => {
      // Segunda 08:00 BRT = 11:00 UTC
      const monday8h = new Date('2026-05-25T11:00:00.000Z')
      expect(isBusinessHour(monday8h)).toBe(false)
    })

    it('retorna false depois do horário comercial', () => {
      // Segunda 19:00 BRT = 22:00 UTC
      const monday19h = new Date('2026-05-25T22:00:00.000Z')
      expect(isBusinessHour(monday19h)).toBe(false)
    })

    it('retorna false no sábado', () => {
      // Sábado 23/05/2026 às 10:00 BRT = 13:00 UTC
      const saturday10h = new Date('2026-05-23T13:00:00.000Z')
      expect(isBusinessHour(saturday10h)).toBe(false)
    })

    it('retorna false no domingo', () => {
      // Domingo 24/05/2026 às 10:00 BRT = 13:00 UTC
      const sunday10h = new Date('2026-05-24T13:00:00.000Z')
      expect(isBusinessHour(sunday10h)).toBe(false)
    })

    it('respeita startHour e endHour customizados', () => {
      // Segunda 10:00 BRT = 13:00 UTC
      const monday10h = new Date('2026-05-25T13:00:00.000Z')
      expect(isBusinessHour(monday10h, 11, 18)).toBe(false) // antes das 11h
      expect(isBusinessHour(monday10h, 9, 18)).toBe(true) // dentro das 9-18h
    })
  })

  describe('sleep()', () => {
    it('espera aproximadamente o tempo correto', async () => {
      const start = Date.now()
      await sleep(50)
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(45) // tolerância de 5ms
      expect(elapsed).toBeLessThan(150) // não deve demorar muito mais
    })
  })

  describe('nowISO()', () => {
    it('retorna string ISO com offset', () => {
      const iso = nowISO()
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
    })
  })
})
