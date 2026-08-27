/**
 * tests/unit/lidia.test.ts
 *
 * Testes para src/lidia/status.ts
 *
 * Cobertura:
 *   - detectTakeoverCommand() — todas as variações
 *   - checkLidiaStatus() — com mock de Pool
 *   - createLeadEntry() — idempotência
 *   - setLidiaStatus() — atualização
 */

import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  detectTakeoverCommand,
  checkLidiaStatus,
  createLeadEntry,
  setLidiaStatus,
} from '../../src/lidia/status.js'

// ─── mock do Pool ─────────────────────────────────────────────────────────────

function makeMockPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  }
}

// ─── detectTakeoverCommand ────────────────────────────────────────────────────

describe('detectTakeoverCommand()', () => {
  it('detecta "Roberta aqui!" como OFF', () => {
    expect(detectTakeoverCommand('Roberta aqui!')).toBe('OFF')
  })

  it('detecta "Roberta aqui" sem exclamação como OFF', () => {
    expect(detectTakeoverCommand('Roberta aqui')).toBe('OFF')
  })

  it('detecta case-insensitive', () => {
    expect(detectTakeoverCommand('ROBERTA AQUI!')).toBe('OFF')
    expect(detectTakeoverCommand('roberta aqui!')).toBe('OFF')
  })

  it('detecta "Roberta aqui!" no meio de uma frase como OFF', () => {
    expect(detectTakeoverCommand('Oi cliente! Roberta aqui! Tudo bem?')).toBe('OFF')
  })

  it('detecta "tá mais!" como ON', () => {
    expect(detectTakeoverCommand('tá mais!')).toBe('ON')
  })

  it('detecta "ta mais!" (sem acento) como ON', () => {
    expect(detectTakeoverCommand('ta mais!')).toBe('ON')
  })

  it('detecta "tá mais" sem exclamação como ON', () => {
    expect(detectTakeoverCommand('tá mais')).toBe('ON')
  })

  it('retorna null para mensagens normais', () => {
    expect(detectTakeoverCommand('Obrigada!')).toBeNull()
    expect(detectTakeoverCommand('Olá, como posso ajudar?')).toBeNull()
    expect(detectTakeoverCommand('Vou verificar isso para você')).toBeNull()
    expect(detectTakeoverCommand('')).toBeNull()
  })

  it('OFF tem prioridade sobre ON se ambos presentes (borda)', () => {
    // Roberta aqui é testado primeiro no código
    expect(detectTakeoverCommand('Roberta aqui! tá mais!')).toBe('OFF')
  })
})

// ─── checkLidiaStatus ─────────────────────────────────────────────────────────

describe('checkLidiaStatus()', () => {
  it('retorna exists=false quando lead não existe', async () => {
    const pool = makeMockPool([]) // rows vazio
    const result = await checkLidiaStatus(pool as never, '5511999887766')

    expect(result.exists).toBe(false)
    expect(result.lidia).toBeNull()
  })

  it('retorna exists=true e lidia=ON quando lidia é ON', async () => {
    const pool = makeMockPool([{ lidia: 'ON' }])
    const result = await checkLidiaStatus(pool as never, '5511999887766')

    expect(result.exists).toBe(true)
    expect(result.lidia).toBe('ON')
  })

  it('retorna exists=true e lidia=OFF quando lidia é OFF', async () => {
    const pool = makeMockPool([{ lidia: 'OFF' }])
    const result = await checkLidiaStatus(pool as never, '5511999887766')

    expect(result.exists).toBe(true)
    expect(result.lidia).toBe('OFF')
  })

  it('usa default ON quando coluna lidia é NULL', async () => {
    const pool = makeMockPool([{ lidia: null }])
    const result = await checkLidiaStatus(pool as never, '5511999887766')

    expect(result.exists).toBe(true)
    expect(result.lidia).toBe('ON')
  })

  it('passa o telefone como parâmetro da query', async () => {
    const pool = makeMockPool([{ lidia: 'ON' }])
    await checkLidiaStatus(pool as never, '5581999887766')

    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['5581999887766'])
  })

  it('retorna fail-open (ON) quando DB lança erro', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('DB offline')) }
    const result = await checkLidiaStatus(pool as never, '5511999887766')

    // Fail-open: melhor responder do que ficar mudo
    expect(result.exists).toBe(true)
    expect(result.lidia).toBe('ON')
  })
})

// ─── createLeadEntry ──────────────────────────────────────────────────────────

describe('createLeadEntry()', () => {
  it('faz INSERT com os campos corretos', async () => {
    const pool = makeMockPool()
    await createLeadEntry(pool as never, { phone: '5511999887766', name: 'João Silva' })

    expect(pool.query).toHaveBeenCalledOnce()
    const [sql, params] = (pool.query as Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO "LeadsAlexy"')
    // ON CONFLICT (telefone) NÃO funciona: a tabela só tem índice único em `id`,
    // e o Postgres recusa o comando. Como o catch trata a falha como não-crítica,
    // o INSERT falhava em silêncio e o takeover não desligava a IA.
    expect(sql).not.toContain('ON CONFLICT')
    expect(sql).toContain('WHERE NOT EXISTS')
    expect(params).toContain('João Silva')
    expect(params).toContain('5511999887766')
  })

  it('não repete o lead quando o telefone já existe', async () => {
    const pool = makeMockPool()
    await createLeadEntry(pool as never, { phone: '5511999887766' })
    const [sql] = (pool.query as Mock).mock.calls[0] as [string, unknown[]]
    // a guarda tem que olhar o TELEFONE — é a chave real, mesmo sem constraint
    expect(sql).toMatch(/WHERE NOT EXISTS[\s\S]*telefone\s*=/)
  })

  it('usa null quando nome não é fornecido', async () => {
    const pool = makeMockPool()
    await createLeadEntry(pool as never, { phone: '5511999887766' })

    const [, params] = (pool.query as Mock).mock.calls[0] as [string, unknown[]]
    expect(params[0]).toBeNull()
  })

  it('não lança erro quando DB falha (não crítico)', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('DB error')) }
    // Não deve propagar o erro
    await expect(createLeadEntry(pool as never, { phone: '5511' })).resolves.toBeUndefined()
  })
})

// ─── setLidiaStatus ───────────────────────────────────────────────────────────

describe('setLidiaStatus()', () => {
  it('faz UPDATE com status e telefone corretos', async () => {
    const pool = makeMockPool()
    await setLidiaStatus(pool as never, '5511999887766', 'OFF')

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "LeadsAlexy"'), [
      'OFF',
      '5511999887766',
    ])
  })

  it('funciona para status ON também', async () => {
    const pool = makeMockPool()
    await setLidiaStatus(pool as never, '5581988877766', 'ON')

    const [, params] = (pool.query as Mock).mock.calls[0] as [string, unknown[]]
    expect(params[0]).toBe('ON')
  })

  it('propaga erro quando DB falha', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('DB error')) }
    await expect(setLidiaStatus(pool as never, '5511', 'OFF')).rejects.toThrow('DB error')
  })
})
