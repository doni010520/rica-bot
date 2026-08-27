/**
 * tests/unit/crm-thread.test.ts
 *
 * O thread do CRM (deal_messages) não pode ter buracos nem duplicatas.
 *
 * Regras cobertas:
 *   - toque de follow-up → vira registro em deal_messages (sender system_followup)
 *   - mensagem a executivo/time → NÃO vira registro
 *   - resposta normal da Rica → EXATAMENTE um registro (anti-duplicação)
 *
 * A camada HTTP é mockada (fetch global), igual aos demais testes unitários.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── mocks de infra ───────────────────────────────────────────────────────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
vi.mock('../../src/lib/db.js', () => ({
  getPool: () => ({ query: mockQuery }),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ─── helpers ──────────────────────────────────────────────────────────────────

function okResponse() {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') } as Response)
}

type SavedMessage = {
  phone: string
  direction: string
  text: string
  sender: string
  deal_id?: string
}

/** Chamadas ao POST /api/crm/messages capturadas no fetch mockado. */
function savedMessages(): SavedMessage[] {
  return mockFetch.mock.calls
    .filter(([url]) => String(url).includes('/api/crm/messages'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as SavedMessage)
}

/** saveMessage é fire-and-forget: dá tempo das promises pendentes rodarem. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

const LEAD_PHONE = '5511999887766'
const EXEC_PHONE = process.env['EXEC_ANDRE_PHONE'] as string

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockImplementation(okResponse)
  mockQuery.mockClear()
  vi.resetModules()
})

// ─── follow-up ────────────────────────────────────────────────────────────────

describe('follow-up de lead → deal_messages', () => {
  it('grava o toque com sender system_followup e o deal_id', async () => {
    const { sendWhatsApp } = await import('../../src/uazapi/client.js')

    await sendWhatsApp(LEAD_PHONE, 'Oi! Ficou alguma dúvida? 😊', {
      crmSender: 'system_followup',
      dealId: 'deal-123',
    })
    await flush()

    const msgs = savedMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      phone: LEAD_PHONE,
      direction: 'out',
      sender: 'system_followup',
      deal_id: 'deal-123',
      text: 'Oi! Ficou alguma dúvida? 😊',
    })
  })
})

// ─── time (executivos) ────────────────────────────────────────────────────────

describe('mensagem para o time → NÃO vai para deal_messages', () => {
  it('executivo não gera registro (só rica_mensagens_enviadas)', async () => {
    const { sendWhatsApp } = await import('../../src/uazapi/client.js')

    await sendWhatsApp(EXEC_PHONE, '🔔 Novo lead pra você')
    await flush()

    expect(savedMessages()).toHaveLength(0)
    // continua indo para o log interno, com categoria 'equipe'
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0]?.[1]?.[2]).toBe('equipe')
  })

  it('crmSender null (copiloto/dev) não gera registro nem para não-executivo', async () => {
    const { sendWhatsApp } = await import('../../src/uazapi/client.js')

    await sendWhatsApp('5571900000000', 'Resposta do copiloto', { crmSender: null })
    await flush()

    expect(savedMessages()).toHaveLength(0)
  })

  it('envio com erro no uazapi não grava no thread', async () => {
    mockFetch.mockImplementation((url: string) =>
      String(url).includes('/send/text')
        ? Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve('boom'),
          } as Response)
        : okResponse(),
    )
    const { sendWhatsApp } = await import('../../src/uazapi/client.js')

    await expect(sendWhatsApp(LEAD_PHONE, 'falha', { crmSender: 'rica_ai' })).rejects.toThrow()
    await flush()

    expect(savedMessages()).toHaveLength(0)
  })
})

// ─── anti-duplicação no fluxo principal ──────────────────────────────────────

describe('resposta da Rica no fluxo do webhook', () => {
  it('gera exatamente UM registro out (sem duplicar com o saveMessage do handler)', async () => {
    vi.doMock('../../src/copiloto/aprovacoes.js', () => ({
      tryApproval: vi.fn().mockResolvedValue(false),
    }))
    vi.doMock('../../src/copiloto/whatsapp-copiloto.js', () => ({
      tryCopiloto: vi.fn().mockResolvedValue({ isTeam: false, answer: '', failed: false }),
    }))
    vi.doMock('../../src/copiloto/encaminhar.js', () => ({
      encaminharLeadManual: vi.fn().mockResolvedValue(''),
    }))
    vi.doMock('../../src/memory/postgres-chat.js', () => ({
      loadChatHistory: vi.fn().mockResolvedValue([]),
      historyToMessages: vi.fn().mockReturnValue([]),
      saveChatTurn: vi.fn().mockResolvedValue(undefined),
      clearChatHistory: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock('../../src/crm/pre-fetch.js', () => ({
      preFetchCrm: vi.fn().mockResolvedValue({ dealId: 'deal-abc', contactName: 'João' }),
    }))
    vi.doMock('../../src/tools/index.js', () => ({ buildAllTools: vi.fn().mockReturnValue({}) }))
    vi.doMock('../../src/agent/rica.js', () => ({
      runRica: vi.fn().mockResolvedValue({ text: 'Claro, posso te ajudar!', usedFallback: false }),
    }))
    vi.doMock('../../src/followup/lead-followup.js', () => ({
      scheduleLeadFollowup: vi.fn().mockResolvedValue(undefined),
      cancelLeadFollowup: vi.fn().mockResolvedValue(undefined),
    }))

    const { handleBufferedMessage } = await import('../../src/webhook/handler.js')

    await handleBufferedMessage(
      { phone: LEAD_PHONE, combinedText: 'Quero saber sobre o diagnóstico', messageCount: 1 },
      { pool: { query: mockQuery } as never },
    )
    await flush()

    const msgs = savedMessages()
    const out = msgs.filter((m) => m.direction === 'out')
    const inbound = msgs.filter((m) => m.direction === 'in')

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ sender: 'rica_ai', deal_id: 'deal-abc' })
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({ sender: 'cliente' })
    // 20s: reimportar o grafo do handler (pdf-parse, copiloto...) passa dos 5s default
  }, 20_000)
})
