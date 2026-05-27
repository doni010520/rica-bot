/**
 * tests/unit/candidato.test.ts
 * Testes para isJobCandidate() — replica o IF_Candidato do n8n.
 */

import { describe, it, expect } from 'vitest'
import { isJobCandidate } from '../../src/candidato/detect.js'

describe('isJobCandidate()', () => {
  describe('palavras-chave que disparam (true)', () => {
    const positive = [
      'Tenho interesse em uma vaga',
      'Estou procurando emprego',
      'Quero enviar meu currículo',
      'Vim me candidatar',
      'Participar da seleção',
      'Processo seletivo',
      'Processo.seletivo',
      'Trainee da empresa',
      'Estou em estágio',
      'Quero trabalhar aí',
      'Quero contratar pessoas',
      'Oportunidade de trabalho',
      'Falar com o RH',
      'Departamento de recursos humanos',
      'Interesse numa vaga disponível',
      'Enviar curriculo',    // sem acento
      'Enviar currículo',   // com acento
      'currículos aceitos',
    ]

    for (const msg of positive) {
      it(`detecta: "${msg}"`, () => {
        expect(isJobCandidate(msg)).toBe(true)
      })
    }
  })

  describe('mensagens normais de clientes (false)', () => {
    const negative = [
      'Quero saber sobre diagnóstico empresarial',
      'Como funciona o GPS Resultado?',
      'Tenho uma padaria',
      'Quero melhorar meu negócio',
      'Preciso de consultoria',
      'Quanto custa o serviço?',
      'Olá, tudo bem?',
      'Vim pelo anúncio do Instagram',
      'Sou empresário do ramo alimentício',
    ]

    for (const msg of negative) {
      it(`não detecta: "${msg}"`, () => {
        expect(isJobCandidate(msg)).toBe(false)
      })
    }
  })

  describe('case-insensitive (flag /i)', () => {
    it('VAGA em maiúsculas', () => {
      expect(isJobCandidate('TENHO INTERESSE EM UMA VAGA')).toBe(true)
    })
    it('Currículo capitalizado', () => {
      expect(isJobCandidate('Quero mandar meu Currículo')).toBe(true)
    })
  })

  describe('\\b no rh — não pega substrings', () => {
    it('rh isolado detecta', () => {
      expect(isJobCandidate('falar com o rh')).toBe(true)
    })
    it('rh como parte de palavra não detecta', () => {
      // "trabalho" contém "rh" mas não como word boundary
      // O regex usa \b então "trabalho" não deve disparar por "rh"
      expect(isJobCandidate('gosto do meu trabalho')).toBe(false)
    })
  })
})
