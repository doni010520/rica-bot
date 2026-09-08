import { describe, it, expect } from 'vitest'
import { houveToolCall } from '../../src/agent/rica.js'

/**
 * Quando o modelo nao devolve texto, esta funcao decide o que o cliente le:
 *
 *  - nenhuma tool rodou  -> "pode repetir o que voce escreveu?"
 *  - alguma tool rodou   -> a acao ja aconteceu, entao NAO pede repeticao
 *
 * Em 07/09/2026 o lead do JDL foi encaminhado com sucesso as 11:51:57 e recebeu
 * o pedido de repeticao as 11:51:58. Nunca mais respondeu.
 */
const comSteps = (steps: unknown) => ({ steps }) as unknown as Parameters<typeof houveToolCall>[0]

describe('houveToolCall', () => {
  it('detecta a tool chamada no unico passo', () => {
    expect(houveToolCall(comSteps([{ toolCalls: [{ toolName: 'notificar_equipe' }] }]))).toBe(true)
  })

  it('detecta a tool mesmo quando ela veio depois de um passo de texto', () => {
    expect(houveToolCall(comSteps([
      { toolCalls: [] },
      { toolCalls: [{ toolName: 'buscar_documentos' }] },
    ]))).toBe(true)
  })

  it('resposta so de texto nao conta como tool', () => {
    expect(houveToolCall(comSteps([{ toolCalls: [] }]))).toBe(false)
  })

  it('nao quebra quando nao ha passo nenhum', () => {
    expect(houveToolCall(comSteps([]))).toBe(false)
    expect(houveToolCall(comSteps(undefined))).toBe(false)
  })

  it('nao quebra quando o passo vem sem o campo toolCalls', () => {
    expect(houveToolCall(comSteps([{}]))).toBe(false)
  })
})
