/**
 * Follow-up só entre 8h e 20h de Recife, em TODAS as campanhas (07/10/2026:
 * toques da Mentoria e da Jornada saíam de 0h a 2h).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const add = vi.fn()
vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({ add: (...a: unknown[]) => add(...a), remove: vi.fn().mockResolvedValue(1) })),
  Worker: vi.fn(),
}))

const { scheduleLeadFollowup } = await import('../../src/followup/lead-followup.js')

const recife = (iso: string) => new Date(`${iso}-03:00`)
const horaDoEnvio = () => {
  const [, , opts] = add.mock.calls.at(-1) as [string, unknown, { delay: number }]
  return new Date(Date.now() + opts.delay)
}

describe('janela de horário do follow-up', () => {
  beforeEach(() => { add.mockReset(); vi.useFakeTimers() })
  afterEach(() => vi.useRealTimers())

  for (const campanha of ['mentoria', 'jdl', 'gps']) {
    it(`${campanha}: toque que cairia de madrugada vai para as 8h`, async () => {
      vi.setSystemTime(recife('2026-10-06T23:30:00'))
      await scheduleLeadFollowup('5581999990001', 1, undefined, campanha)
      expect(horaDoEnvio().toISOString()).toBe(recife('2026-10-07T08:00:00').toISOString())
    })
  }

  it('dentro do horário o toque sai no prazo normal', async () => {
    vi.setSystemTime(recife('2026-10-07T10:00:00'))
    await scheduleLeadFollowup('5581999990001', 1, undefined, 'mentoria')
    const envio = horaDoEnvio()
    expect(envio.getTime()).toBeGreaterThan(Date.now())
    expect(envio.getTime()).toBeLessThan(recife('2026-10-07T20:00:00').getTime())
  })
})
