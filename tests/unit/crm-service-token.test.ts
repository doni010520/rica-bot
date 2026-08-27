/**
 * tests/unit/crm-service-token.test.ts
 * Autenticação de serviço no CRM: header x-service-token só vai quando
 * CRM_SERVICE_TOKEN está preenchida (retrocompatível com o CRM antigo).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { crmHeaders, crmRequest } from '../../src/lib/crm-client.js'
import { env } from '../../src/lib/env.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function okResponse() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true }),
  } as Response)
}

const ORIGINAL_TOKEN = env.CRM_SERVICE_TOKEN

describe('crmHeaders()', () => {
  afterEach(() => {
    env.CRM_SERVICE_TOKEN = ORIGINAL_TOKEN
  })

  it('sem token configurado → só Content-Type', () => {
    env.CRM_SERVICE_TOKEN = ''
    const headers = crmHeaders()
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['x-service-token']).toBeUndefined()
  })

  it('com token configurado → envia x-service-token', () => {
    env.CRM_SERVICE_TOKEN = 'service-key-123'
    expect(crmHeaders()['x-service-token']).toBe('service-key-123')
  })

  it('aceita headers extras sem perder o token', () => {
    env.CRM_SERVICE_TOKEN = 'service-key-123'
    const headers = crmHeaders({ 'x-request-id': 'abc' })
    expect(headers['x-service-token']).toBe('service-key-123')
    expect(headers['x-request-id']).toBe('abc')
  })
})

describe('crmRequest()', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    env.CRM_SERVICE_TOKEN = ORIGINAL_TOKEN
  })

  it('propaga o x-service-token para a chamada HTTP', async () => {
    env.CRM_SERVICE_TOKEN = 'service-key-123'
    mockFetch.mockReturnValueOnce(okResponse())

    await crmRequest('/api/crm/pipelines')

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-service-token']).toBe('service-key-123')
  })

  it('não envia o header quando a env está vazia', async () => {
    env.CRM_SERVICE_TOKEN = ''
    mockFetch.mockReturnValueOnce(okResponse())

    await crmRequest('/api/crm/pipelines')

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-service-token']).toBeUndefined()
  })
})
