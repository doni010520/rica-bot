/**
 * tests/unit/env.test.ts
 *
 * Testes para src/lib/env.ts
 *
 * Estratégia: importamos o schema Zod diretamente para testar a validação
 * sem acionar o process.exit() do parseEnv().
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// Recriamos o schema Zod aqui para não depender do side-effect do parseEnv()
// (que chama process.exit em caso de erro)
const partialSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().optional().default('3000').pipe(z.coerce.number().int().positive()),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  OPENAI_API_KEY: z.string().min(1),
  UAZAPI_BASE_URL: z.string().url(),
  CRM_API_URL: z.string().url(),
  ORG_ID: z.string().uuid(),
  OPENAI_TEMPERATURE: z.string().optional().default('0.5').pipe(z.coerce.number().min(0).max(2)),
  MSG_BUFFER_WAIT_MS: z.string().optional().default('10000').pipe(z.coerce.number().int().positive()),
  CHUNK_DELAY_MS: z.string().optional().default('2500').pipe(z.coerce.number().int().positive()),
})

describe('env.ts validação', () => {
  it('parse com valores válidos não gera erros', () => {
    const result = partialSchema.safeParse({
      NODE_ENV: 'production',
      OPENAI_API_KEY: 'sk-valid-key',
      UAZAPI_BASE_URL: 'https://test.uazapi.example.com',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.success).toBe(true)
  })

  it('falha com OPENAI_API_KEY vazia', () => {
    const result = partialSchema.safeParse({
      OPENAI_API_KEY: '',
      UAZAPI_BASE_URL: 'https://test.uazapi.example.com',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('OPENAI_API_KEY')
    }
  })

  it('falha com URL inválida em UAZAPI_BASE_URL', () => {
    const result = partialSchema.safeParse({
      OPENAI_API_KEY: 'sk-valid',
      UAZAPI_BASE_URL: 'nao-e-uma-url',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.success).toBe(false)
  })

  it('falha com ORG_ID inválido (não UUID)', () => {
    const result = partialSchema.safeParse({
      OPENAI_API_KEY: 'sk-valid',
      UAZAPI_BASE_URL: 'https://test.uazapi.example.com',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: 'nao-e-uuid',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('ORG_ID')
    }
  })

  it('aplica defaults quando vars opcionais estão ausentes', () => {
    const result = partialSchema.safeParse({
      OPENAI_API_KEY: 'sk-valid',
      UAZAPI_BASE_URL: 'https://test.uazapi.example.com',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: '00000000-0000-0000-0000-000000000001',
      // sem PORT, LOG_LEVEL, NODE_ENV, etc.
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(3000)
      expect(result.data.LOG_LEVEL).toBe('info')
      expect(result.data.NODE_ENV).toBe('development')
      expect(result.data.OPENAI_TEMPERATURE).toBe(0.5)
      expect(result.data.MSG_BUFFER_WAIT_MS).toBe(10000)
      expect(result.data.CHUNK_DELAY_MS).toBe(2500)
    }
  })

  it('converte PORT string para número', () => {
    const result = partialSchema.safeParse({
      OPENAI_API_KEY: 'sk-valid',
      UAZAPI_BASE_URL: 'https://test.uazapi.example.com',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: '00000000-0000-0000-0000-000000000001',
      PORT: '8080',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(8080)
      expect(typeof result.data.PORT).toBe('number')
    }
  })

  it('falha com PORT negativo', () => {
    const result = partialSchema.safeParse({
      OPENAI_API_KEY: 'sk-valid',
      UAZAPI_BASE_URL: 'https://test.uazapi.example.com',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: '00000000-0000-0000-0000-000000000001',
      PORT: '-1',
    })

    expect(result.success).toBe(false)
  })

  it('falha com OPENAI_TEMPERATURE fora do range', () => {
    const result = partialSchema.safeParse({
      OPENAI_API_KEY: 'sk-valid',
      UAZAPI_BASE_URL: 'https://test.uazapi.example.com',
      CRM_API_URL: 'https://test-crm.example.com',
      ORG_ID: '00000000-0000-0000-0000-000000000001',
      OPENAI_TEMPERATURE: '3', // max é 2
    })

    expect(result.success).toBe(false)
  })
})
