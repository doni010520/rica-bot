/**
 * src/tools/blindagem.ts
 *
 * Nenhuma tool pode derrubar o atendimento.
 *
 * POR QUE ISTO EXISTE: em 07/09 tratamos o "Tive algum problema aqui no meu
 * whatsapp, pode repetir?" como resposta vazia do modelo e pusemos retry. Não
 * resolveu: foram 14 casos de 08 a 17/09. O log mostrou a causa real — o
 * generateText LANÇAVA exceção, e aí o retry nem roda:
 *
 *   - InvalidToolArgumentsError em atualiza_nome: o modelo mandava `name` e o
 *     schema exige `nome`. Por isso acontecia logo depois do cliente dizer o
 *     próprio nome ("Moriá", "Pan").
 *   - ToolExecutionError em salvar_insight: lead sem deal ainda → POST
 *     /api/crm/deals//insights → 404. Duas vezes rodou em paralelo com
 *     notificar_equipe: o André recebeu o lead e o cliente recebeu "pode repetir?".
 *
 * Uma tool auxiliar (salvar insight, atualizar nome) falhar é aceitável; a
 * conversa com o cliente cair por isso, não.
 */

import type { LanguageModelV1FunctionToolCall } from '@ai-sdk/provider'
import { InvalidToolArgumentsError, type CoreTool } from 'ai'
import { logger } from '../observability/logger.js'

export const RESPOSTA_TOOL_FALHOU = {
  success: false,
  message: 'Essa ação não pôde ser concluída agora.',
  instrucao: 'Siga a conversa normalmente com o cliente. NÃO mencione erro, sistema ou problema técnico.',
} as const

/**
 * Embrulha o execute de cada tool: exceção vira resultado de falha que o modelo
 * lê e contorna. Tool que opera sobre deal e recebe deal_id vazio nem chama a
 * API — o lead simplesmente ainda não tem negócio no CRM.
 */
export function blindarTools<T extends Record<string, CoreTool>>(tools: T, phone: string): T {
  const log = logger.child({ phone: phone.slice(-4), context: 'blindagem' })
  const out: Record<string, CoreTool> = {}
  for (const [nome, t] of Object.entries(tools)) {
    if (typeof t?.execute !== 'function') {
      out[nome] = t
      continue
    }
    const original = t.execute
    out[nome] = {
      ...t,
      execute: async (args: any, options: any) => {
        if (args && typeof args === 'object' && 'deal_id' in args && !String(args.deal_id ?? '').trim()) {
          log.info({ tool: nome }, 'deal_id vazio — lead ainda sem negócio no CRM, ação pulada')
          return {
            success: false,
            message: 'Este contato ainda não tem negócio no CRM; nada foi salvo.',
            instrucao: RESPOSTA_TOOL_FALHOU.instrucao,
          }
        }
        try {
          return await original(args, options)
        } catch (err) {
          log.warn({ err, tool: nome }, 'Tool falhou — a conversa segue')
          return RESPOSTA_TOOL_FALHOU
        }
      },
    }
  }
  return out as T
}

type JsonSchemaLike = { properties?: Record<string, unknown>; required?: string[] }

/**
 * experimental_repairToolCall: corrige o caso "campo com nome errado".
 *
 * Só conserta quando é inequívoco — falta exatamente UM campo obrigatório e veio
 * exatamente UM campo que o schema não conhece. Aí renomeia. Qualquer outra
 * situação devolve null (não inventa valor).
 */
export async function repararChamadaDeTool({
  toolCall,
  parameterSchema,
  error,
}: {
  toolCall: LanguageModelV1FunctionToolCall
  parameterSchema: (o: { toolName: string }) => unknown
  error: unknown
}): Promise<LanguageModelV1FunctionToolCall | null> {
  if (!InvalidToolArgumentsError.isInstance(error)) return null
  const corrigido = renomearCampoErrado(toolCall.args, parameterSchema({ toolName: toolCall.toolName }) as JsonSchemaLike)
  if (!corrigido) return null
  logger.warn(
    { context: 'blindagem', tool: toolCall.toolName, de: corrigido.de, para: corrigido.para },
    'Argumento de tool com nome errado — corrigido',
  )
  return { ...toolCall, args: corrigido.args }
}

export function renomearCampoErrado(
  argsJson: string,
  schema: JsonSchemaLike,
): { args: string; de: string; para: string } | null {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson)
  } catch {
    return null
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const conhecidos = Object.keys(schema.properties ?? {})
  const faltando = (schema.required ?? []).filter((k) => !(k in args))
  const sobrando = Object.keys(args).filter((k) => !conhecidos.includes(k))
  if (faltando.length !== 1 || sobrando.length !== 1) return null
  const [para] = faltando as [string]
  const [de] = sobrando as [string]
  const { [de]: valor, ...resto } = args
  return { args: JSON.stringify({ ...resto, [para]: valor }), de, para }
}
