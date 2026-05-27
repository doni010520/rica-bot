/**
 * tests/unit/admin-commands.test.ts
 * Testes para src/commands/admin.ts — replica exata do Code + Switch2 do n8n.
 */

import { describe, it, expect } from 'vitest'
import { detectAdminCommand } from '../../src/commands/admin.js'

describe('detectAdminCommand()', () => {
  describe('REVOKE (mensagem apagada)', () => {
    it('retorna revoke quando isRevoke=true', () => {
      expect(detectAdminCommand('qualquer texto', true)).toBe('revoke')
    })
    it('isRevoke tem prioridade sobre qualquer texto', () => {
      expect(detectAdminCommand('LimparDados', true)).toBe('revoke')
      expect(detectAdminCommand('TreinoIA12', true)).toBe('revoke')
    })
  })

  describe('LimparDados', () => {
    it('detecta comando exato', () => {
      expect(detectAdminCommand('LimparDados')).toBe('limpar')
    })
    it('detecta com texto após o comando', () => {
      expect(detectAdminCommand('LimparDados agora')).toBe('limpar')
    })
    it('case-sensitive — não detecta variações', () => {
      expect(detectAdminCommand('limpardados')).toBe('atendimento')
      expect(detectAdminCommand('LIMPARDADOS')).toBe('atendimento')
      expect(detectAdminCommand('Limpar Dados')).toBe('atendimento')
    })
    it('sem trim — espaço antes não detecta (paridade com n8n)', () => {
      expect(detectAdminCommand(' LimparDados')).toBe('atendimento')
    })
  })

  describe('TreinoIA12 e variantes', () => {
    it('detecta TreinoIA12', () => {
      expect(detectAdminCommand('TreinoIA12')).toBe('treino')
    })
    it('detecta AgendaIA12', () => {
      expect(detectAdminCommand('AgendaIA12')).toBe('treino')
    })
    it('detecta ArquivosIA12', () => {
      expect(detectAdminCommand('ArquivosIA12')).toBe('treino')
    })
    it('detecta BaseIA12', () => {
      expect(detectAdminCommand('BaseIA12')).toBe('treino')
    })
    it('case-sensitive', () => {
      expect(detectAdminCommand('treinoIA12')).toBe('atendimento')
    })
  })

  describe('DisparoRica12', () => {
    it('detecta DisparoRica12', () => {
      expect(detectAdminCommand('DisparoRica12')).toBe('disparos')
    })
    it('detecta com sufixo', () => {
      expect(detectAdminCommand('DisparoRica12 campanha_x')).toBe('disparos')
    })
    it('case-sensitive', () => {
      expect(detectAdminCommand('disparorica12')).toBe('atendimento')
    })
  })

  describe('fluxo padrão (atendimento)', () => {
    it('mensagens comuns vão para atendimento', () => {
      expect(detectAdminCommand('Olá, quero diagnóstico')).toBe('atendimento')
      expect(detectAdminCommand('Oi')).toBe('atendimento')
      expect(detectAdminCommand('')).toBe('atendimento')
      expect(detectAdminCommand('Como funciona o GPS Resultado?')).toBe('atendimento')
    })
    it('texto que contém mas não começa com o comando → atendimento', () => {
      expect(detectAdminCommand('preciso de LimparDados')).toBe('atendimento')
      expect(detectAdminCommand('sobre o TreinoIA12')).toBe('atendimento')
    })
  })
})
