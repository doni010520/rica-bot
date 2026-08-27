/**
 * tests/unit/whatsapp-link.test.ts
 *
 * O André não conseguia abrir os contatos que a Rica encaminhava. A causa: cinco
 * lugares montavam o link como `phone.replace(/^55/, '')`, e o wa.me EXIGE o
 * código do país — `wa.me/22997314556` não abre conversa nenhuma.
 *
 * Estes testes fixam o comportamento com os números reais que ele recebeu.
 */
import { describe, it, expect } from 'vitest'
import { whatsappLink, normalizePhone } from '../../src/uazapi/normalize-phone.js'
import { buildExecutiveMessage } from '../../src/routing/executive-router.js'

describe('whatsappLink()', () => {
  // Números que apareceram de verdade em rica_mensagens_enviadas
  it.each([
    ['5522997314556', 'https://wa.me/5522997314556'], // Pablo
    ['558791111194', 'https://wa.me/558791111194'],   // Laudelina
    ['5521986849179', 'https://wa.me/5521986849179'], // Carla
    ['553187128208', 'https://wa.me/553187128208'],
  ])('mantém o DDI em %s', (entrada, esperado) => {
    expect(whatsappLink(entrada)).toBe(esperado)
  })

  it('NUNCA devolve link sem código do país (a regressão que quebrou o André)', () => {
    for (const tel of ['5522997314556', '558791111194', '5511958430345', '553187128208']) {
      const link = whatsappLink(tel)
      expect(link).toMatch(/^https:\/\/wa\.me\/55\d{10,11}$/)
      // o formato antigo, que não abria
      expect(link).not.toBe(`https://wa.me/${tel.replace(/^55/, '')}`)
    }
  })

  it('aceita telefone sujo (espaços, parênteses, +) e ainda gera link válido', () => {
    expect(whatsappLink('+55 (21) 98684-9179')).toBe('https://wa.me/5521986849179')
    expect(whatsappLink('21 98684-9179')).toBe('https://wa.me/5521986849179')
  })

  it('não força 55 em número estrangeiro', () => {
    // normalizePhone reconhece NANP (EUA/Canadá) — link não pode virar 55+...
    const link = whatsappLink('12125551234')
    expect(link).toBe(`https://wa.me/${normalizePhone('12125551234')}`)
    expect(link).not.toMatch(/wa\.me\/5512125551234/)
  })

  it('é sempre uma URL completa, para o WhatsApp reconhecer como link', () => {
    expect(whatsappLink('5521986849179')).toMatch(/^https:\/\//)
  })
})

describe('mensagem que o executivo recebe', () => {
  const msg = buildExecutiveMessage({
    executiveName: 'André Augusto',
    leadName: 'Pablo',
    leadPhone: '5522997314556',
    leadCompany: 'Padaria do Pablo',
    leadEmail: '',
    product: 'GPS Padaria',
    message: 'Quero saber mais',
    state: 'RJ',
    ddd: 22,
  })

  it('traz o link clicável com DDI', () => {
    expect(msg).toContain('https://wa.me/5522997314556')
  })

  it('não contém o link quebrado que o André recebia', () => {
    expect(msg).not.toContain('wa.me/22997314556')
  })
})
