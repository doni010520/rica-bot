import { describe, it, expect, vi, beforeEach } from 'vitest'

const enviadas: Array<{ phone: string; texto: string }> = []
vi.mock('../../src/uazapi/client.js', () => ({
  sendWhatsApp: vi.fn(async (phone: string, texto: string) => { enviadas.push({ phone, texto }) }),
}))
vi.mock('../../src/lib/crm-client.js', () => ({ crmRequest: vi.fn(async () => ({})) }))

const { __test_processExecutiveFollowup } = await import('../../src/followup/executive-followup.js')
const { EXECUTIVES } = await import('../../src/routing/executives.config.js')

describe('cobrança de 24h com executivo que saiu da empresa', () => {
  beforeEach(() => { enviadas.length = 0 })

  // O job e agendado com o executivo congelado no payload e so dispara 24h
  // depois. Em 01/09/2026 a Patricia recebeu duas cobrancas assim, um dia
  // depois de ter saido da empresa.
  it('a cobrança da Patrícia vai para o André, não para ela', async () => {
    await __test_processExecutiveFollowup({
      executivePhone: EXECUTIVES.PATRICIA.phoneFormatted,
      executiveName: 'Patrícia Alves',
      leadName: 'João Ricardo',
      leadPhone: '553592356316',
      product: 'GPS Padaria',
      forwardedAt: new Date().toISOString(),
      assignedVia: 'notificar_equipe',
    })
    const paraExecutivo = enviadas[0]
    expect(paraExecutivo?.phone).toBe(EXECUTIVES.ANDRE.phoneFormatted)
    expect(paraExecutivo?.phone).not.toBe(EXECUTIVES.PATRICIA.phoneFormatted)
    expect(paraExecutivo?.texto).toContain('André')
    expect(paraExecutivo?.texto).not.toContain('Patrícia')
  })

  it('quem continua na empresa recebe normalmente', async () => {
    await __test_processExecutiveFollowup({
      executivePhone: EXECUTIVES.ANDRE.phoneFormatted,
      executiveName: 'André Augusto',
      leadName: 'Márcio',
      leadPhone: '558499740389',
      product: 'GPS Padaria',
      forwardedAt: new Date().toISOString(),
      assignedVia: 'notificar_equipe',
    })
    expect(enviadas[0]?.phone).toBe(EXECUTIVES.ANDRE.phoneFormatted)
  })
})
