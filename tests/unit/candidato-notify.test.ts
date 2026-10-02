/**
 * tests/unit/candidato-notify.test.ts
 * notifyHR: orientação ao candidato sai uma vez; o RH recebe todas as mensagens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendWhatsApp = vi.fn(async () => undefined)
let primeira = true
vi.mock('../../src/uazapi/client.js', () => ({ sendWhatsApp }))
vi.mock('../../src/dedup/redis-incr.js', () => ({ shouldNotify: vi.fn(async () => primeira) }))

const { notifyHR } = await import('../../src/candidato/detect.js')

const base = { candidatePhone: '5571999990451', candidateMessage: 'procuro uma vaga' }
const textos = () => sendWhatsApp.mock.calls.map((c) => String((c as unknown[])[1]))

describe('notifyHR()', () => {
  beforeEach(() => { sendWhatsApp.mockClear(); primeira = true })

  it('primeira mensagem: avisa o RH e orienta o candidato', async () => {
    await notifyHR({ ...base, candidateName: 'Maria Souza' })
    expect(sendWhatsApp).toHaveBeenCalledTimes(2)
    expect(textos()[1]).toContain('Olá Maria! 😊')
  })

  it('"Sem nome" do CRM não vira "Olá Sem"', async () => {
    await notifyHR({ ...base, candidateName: 'Sem nome' })
    expect(textos()[1]).toMatch(/^Olá! 😊/)
    expect(textos()[0]).toContain('*Nome:* Não informado')
  })

  it('mensagens seguintes: só o RH recebe, o candidato não é orientado de novo', async () => {
    primeira = false
    await notifyHR({ ...base, candidateName: 'Sem nome', candidateMessage: '[Imagem]: currículo' })
    expect(sendWhatsApp).toHaveBeenCalledTimes(1)
    expect(textos()[0]).toContain('Nova mensagem de candidato')
    expect(textos()[0]).toContain('[Imagem]: currículo')
  })
})
