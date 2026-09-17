import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { tool, InvalidToolArgumentsError } from 'ai'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { blindarTools, renomearCampoErrado, repararChamadaDeTool, RESPOSTA_TOOL_FALHOU } from '../../src/tools/blindagem.js'

// Casos REAIS do log de 14-17/09/2026, que mandaram "pode repetir?" ao cliente.

describe('renomearCampoErrado', () => {
  const schemaAtualizaNome = {
    properties: { contact_id: {}, nome: {} },
    required: ['contact_id', 'nome'],
  }

  it('atualiza_nome com `name` em vez de `nome` (caso "Moriá" e "Pan")', () => {
    const r = renomearCampoErrado('{"contact_id":"c7345df4","name":"Moriá"}', schemaAtualizaNome)
    expect(r).not.toBeNull()
    expect(JSON.parse(r!.args)).toEqual({ contact_id: 'c7345df4', nome: 'Moriá' })
    expect(r!.de).toBe('name')
    expect(r!.para).toBe('nome')
  })

  it('não inventa quando é ambíguo ou falta mais de um campo', () => {
    expect(renomearCampoErrado('{"name":"Ana"}', schemaAtualizaNome)).toBeNull()
    expect(renomearCampoErrado('{"contact_id":"x","name":"Ana","apelido":"A"}', schemaAtualizaNome)).toBeNull()
    expect(renomearCampoErrado('não é json', schemaAtualizaNome)).toBeNull()
    expect(renomearCampoErrado('{"contact_id":"x","nome":"Ana"}', schemaAtualizaNome)).toBeNull()
  })
})

describe('repararChamadaDeTool', () => {
  const params = z.object({ contact_id: z.string(), nome: z.string() })
  const parameterSchema = () => zodToJsonSchema(params)

  it('conserta InvalidToolArgumentsError de campo renomeado', async () => {
    const toolCall = { toolCallType: 'function' as const, toolCallId: '1', toolName: 'atualiza_nome', args: '{"contact_id":"c1","name":"Pan"}' }
    const error = new InvalidToolArgumentsError({ toolName: 'atualiza_nome', toolArgs: toolCall.args, cause: new Error('x') })
    const r = await repararChamadaDeTool({ toolCall, parameterSchema, error })
    expect(JSON.parse(r!.args)).toEqual({ contact_id: 'c1', nome: 'Pan' })
  })

  it('outros erros não são reparados', async () => {
    const toolCall = { toolCallType: 'function' as const, toolCallId: '1', toolName: 'x', args: '{}' }
    expect(await repararChamadaDeTool({ toolCall, parameterSchema, error: new Error('outro') })).toBeNull()
  })
})

describe('blindarTools', () => {
  const opts = { toolCallId: '1', messages: [] }

  it('exceção da tool vira resultado de falha, não derruba a conversa', async () => {
    const tools = blindarTools(
      {
        salvar_insight: tool({
          description: 'x',
          parameters: z.object({ deal_id: z.string() }),
          execute: async () => {
            throw new Error('CRM POST /api/crm/deals/abc/insights → 500')
          },
        }),
      },
      '5581999990000',
    )
    await expect(tools.salvar_insight.execute!({ deal_id: 'abc' }, opts)).resolves.toEqual(RESPOSTA_TOOL_FALHOU)
  })

  it('deal_id vazio nem chama a API (caso /api/crm/deals//insights → 404)', async () => {
    let chamou = false
    const tools = blindarTools(
      {
        salvar_insight: tool({
          description: 'x',
          parameters: z.object({ deal_id: z.string() }),
          execute: async () => {
            chamou = true
            return { success: true }
          },
        }),
      },
      '5581999990000',
    )
    const r = (await tools.salvar_insight.execute!({ deal_id: '' }, opts)) as { success: boolean }
    expect(chamou).toBe(false)
    expect(r.success).toBe(false)
  })

  it('tool que funciona devolve o resultado original', async () => {
    const tools = blindarTools(
      {
        notificar_equipe: tool({
          description: 'x',
          parameters: z.object({ produto: z.string() }),
          execute: async ({ produto }) => ({ success: true, produto }),
        }),
      },
      '5581999990000',
    )
    expect(await tools.notificar_equipe.execute!({ produto: 'GPS' }, opts)).toEqual({ success: true, produto: 'GPS' })
  })

  it('mantém descrição e parâmetros (o modelo continua enxergando a tool igual)', () => {
    const original = tool({ description: 'desc', parameters: z.object({ a: z.string() }), execute: async () => 1 })
    const b = blindarTools({ t: original }, '5581999990000')
    expect(b.t.description).toBe('desc')
    expect(b.t.parameters).toBe(original.parameters)
  })
})

