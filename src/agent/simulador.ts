/**
 * src/agent/simulador.ts
 *
 * Simulador de conversa com a Rica — para a equipe testar o atendimento sem
 * WhatsApp e sem virar lead no funil.
 *
 * POR QUE ISTO EXISTE: quem é do time (`TEAM_PHONES`) cai no copiloto, não no
 * fluxo de lead — então o dono e a Malu não conseguem testar como cliente pelo
 * próprio WhatsApp. Testar de um número de fora funciona, mas cria deal de
 * verdade e dispara follow-up.
 *
 * A REGRA DE SEGURANÇA: só `buscar_documentos` (leitura pura) executa. Todas as
 * outras tools são INTERCEPTADAS e apenas relatadas. `notificar_equipe`,
 * `designar_lead` e `notificar_andre` mandam WhatsApp para executivo de verdade
 * e mexem no CRM — num simulador isso seria desastroso. O modelo recebe de volta
 * uma confirmação de sucesso (para a conversa seguir naturalmente) e a chamada
 * fica registrada para a tela mostrar o que ELA TERIA FEITO.
 *
 * O prompt e o modelo são os MESMOS de produção: o valor do simulador está em
 * não ser uma segunda implementação que diverge com o tempo.
 */

import { generateText, tool, type CoreTool } from 'ai'
import { openai } from '@ai-sdk/openai'
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { buildSystemPrompt, type CrmContext } from './prompt.js'
import { buildAllTools } from '../tools/index.js'
import { detectarCampanhaDoAnuncio, blocoFunilParaPrompt, type FunilRow } from '../funil/funil.js'
import { avaliarSeELead, respostaNaoELead } from '../qualificacao/porta-lead.js'

/** Tools que podem rodar de verdade: leitura, sem efeito no mundo. */
const TOOLS_SEGURAS = new Set(['buscar_documentos'])

/** Telefone fictício. Nunca deve bater com número real — DDD 99 não existe. */
export const TELEFONE_SIMULADO = '5599000000000'

export type ChamadaDeTool = {
  tool: string
  argumentos: unknown
  executada: boolean
}

export type TurnoSimulado = {
  texto: string
  chamadas: ChamadaDeTool[]
  passos: number
}

export type MensagemSimulada = {
  papel: 'lead' | 'rica'
  texto: string
}

/**
 * Envolve todas as tools: as seguras passam direto, as demais viram
 * "faz de conta" que só registra a intenção.
 */
export function tolsDeSimulacao(
  phone: string,
  pool: Pool,
  registro: ChamadaDeTool[],
  falasDoLead = '',
): Record<string, CoreTool> {
  const reais = buildAllTools(phone, pool) as Record<string, CoreTool>
  const saida: Record<string, CoreTool> = {}

  for (const [nome, original] of Object.entries(reais)) {
    if (TOOLS_SEGURAS.has(nome)) {
      saida[nome] = {
        ...original,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (args: any, opts: any) => {
          registro.push({ tool: nome, argumentos: args, executada: true })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (original as any).execute(args, opts)
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      continue
    }

    // Preserva description e parameters: o schema é o que ensina o modelo a
    // chamar a tool. Trocar por um genérico mudaria o comportamento testado.
    saida[nome] = tool({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      description: (original as any).description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: (original as any).parameters,
      execute: async (args: unknown) => {
        const posicao = registro.push({ tool: nome, argumentos: args, executada: false }) - 1
        // A porta do lead roda de verdade (só lê): sem ela o simulador diria que
        // encaminhou quem a produção barraria.
        if (nome === 'notificar_equipe') {
          const avaliacao = await avaliarSeELead(falasDoLead)
          if (!avaliacao.ehLead) {
            // Pela posição guardada: com duas chamadas em paralelo, "a última"
            // seria a da outra chamada.
            registro[posicao] = { tool: 'notificar_equipe (barrado: não é lead)', argumentos: args, executada: false }
            return respostaNaoELead(avaliacao.motivo)
          }
        }
        return {
          success: true,
          simulado: true,
          message:
            `[SIMULAÇÃO] "${nome}" NÃO foi executada de verdade. ` +
            'Considere que deu certo e siga a conversa normalmente.',
          // GPS: sem uma URL o modelo não tem o que mandar e o teste não mostra o convite.
          ...(nome === 'enviar_link_agenda_andre'
            ? { url: 'https://sucessocrm.benitechlab.com/api/agendar/LINK-DE-TESTE', instrucao: 'Mande o convite padrão com esta URL em linha própria, depois a frase de que a reunião entra sozinha na agenda do André.' }
            : {}),
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
  }

  return saida
}

/**
 * Roda um turno da conversa simulada.
 *
 * O histórico vem inteiro do cliente a cada chamada — de propósito: nada é
 * gravado em `n8n_chat_histories` nem em `deal_messages`, então a simulação não
 * suja a memória da Rica nem aparece na tela de Conversas.
 */
export async function simularTurno(
  mensagens: MensagemSimulada[],
  pool: Pool,
  opcoes: { nome?: string | undefined; comTools?: boolean | undefined } = {},
): Promise<TurnoSimulado> {
  const nome = opcoes.nome?.trim() || 'Cliente (simulação)'
  const comTools = opcoes.comTools ?? true
  const log = logger.child({ context: 'simulador' })

  // CRM vazio: a simulação não deve puxar cadastro real de ninguém.
  const crm: CrmContext = { exists: false, phone: TELEFONE_SIMULADO }

  // Campanha pela mensagem pronta do anúncio, como no webhook: sem o bloco do
  // funil a simulação não reproduz a primeira resposta das campanhas.
  const primeira = mensagens.find((m) => m.papel === 'lead')?.texto ?? ''
  const anuncio = detectarCampanhaDoAnuncio(primeira)
  if (anuncio) {
    const jaRespondeu = mensagens.some((m) => m.papel === 'rica')
    crm.funil = blocoFunilParaPrompt({
      campanha: anuncio.campanha,
      etapa: jaRespondeu ? 'engajou' : 'novo',
      origem: anuncio.origem,
      message_count_rica: mensagens.filter((m) => m.papel === 'rica').length,
    } as unknown as FunilRow)
  }

  const systemPrompt = buildSystemPrompt(crm, TELEFONE_SIMULADO, nome)
  const registro: ChamadaDeTool[] = []
  // Só as falas do lead, como na produção (ver src/qualificacao/porta-lead.ts).
  const falasDoLead = mensagens.filter((m) => m.papel === 'lead').map((m) => `LEAD: ${m.texto}`).join('\n')
  const tools = comTools ? tolsDeSimulacao(TELEFONE_SIMULADO, pool, registro, falasDoLead) : {}

  const historico = mensagens.map((m) => ({
    role: m.papel === 'lead' ? ('user' as const) : ('assistant' as const),
    content: m.texto,
  }))

  try {
    const resultado = await generateText({
      model: openai(env.OPENAI_MODEL),
      temperature: env.OPENAI_TEMPERATURE,
      system: systemPrompt,
      messages: historico,
      ...(comTools ? { tools, maxSteps: 10 } : {}),
    })

    const texto = resultado.text?.trim() ?? ''
    log.info(
      { passos: resultado.steps?.length ?? 0, chamadas: registro.length, respostaVazia: !texto },
      'turno simulado',
    )

    return { texto, chamadas: registro, passos: resultado.steps?.length ?? 0 }
  } catch (err) {
    log.error({ err }, 'falha no turno simulado')
    throw err
  }
}
