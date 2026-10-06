/**
 * Cache de prompt da OpenAI: o prefixo do system prompt tem que ser idêntico
 * entre leads e entre mensagens. Tudo que varia vai para <contexto_da_conversa>,
 * no fim (ver src/agent/prompt.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import { buildSystemPrompt } from '../../src/agent/prompt.js'

const MARCA = '<contexto_da_conversa>'

function prefixo(p: string) {
  return p.slice(0, p.lastIndexOf(MARCA))
}

describe('system prompt e cache da OpenAI', () => {
  it('dois leads diferentes, em horários diferentes, têm o mesmo prefixo', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-06T10:00:00-03:00'))
    const a = buildSystemPrompt(
      { exists: true, contactId: 'c1', contactName: 'Ana', dealId: 'd1', phone: '5581999990001', funil: '<funil_do_lead>gps / novo</funil_do_lead>' },
      '5581999990001', 'Ana')
    vi.setSystemTime(new Date('2026-10-07T16:42:13-03:00'))
    const b = buildSystemPrompt({ exists: false, phone: '5511888880002' }, '5511888880002', 'Bruno')
    vi.useRealTimers()

    expect(prefixo(a).length).toBeGreaterThan(50_000)
    expect(prefixo(a)).toBe(prefixo(b))
  })

  it('o que varia fica só no bloco do fim', () => {
    const p = buildSystemPrompt(
      { exists: true, contactName: 'Ana', dealId: 'deal-123', phone: '5581999990001', funil: '<funil_do_lead>mentoria</funil_do_lead>' },
      '5581999990001', 'Ana Paula')
    const fim = p.slice(p.lastIndexOf(MARCA))
    expect(p.trimEnd().endsWith('</contexto_da_conversa>')).toBe(true)
    for (const valor of ['5581999990001', 'Ana Paula', 'deal-123', '<funil_do_lead>mentoria', 'Hoje é:']) {
      expect(fim).toContain(valor)
      expect(prefixo(p)).not.toContain(valor)
    }
    expect(prefixo(p)).not.toMatch(/\{\{/)
  })
})
