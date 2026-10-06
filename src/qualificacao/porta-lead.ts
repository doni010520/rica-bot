/**
 * src/qualificacao/porta-lead.ts
 *
 * Porta de entrada do notificar_equipe: confirma que a pessoa é um cliente
 * possível antes de avisar executivo e Maria.
 *
 * POR QUE NO CÓDIGO: em 05/10/2026 um mecânico sem oficina, que pedia dinheiro
 * ("50 mil dólares"), virou "lead quentinho" para a Maria (2x) e o André. A
 * regra equivalente no prompt (passo zero do <regra_critica_escalation>) não
 * segurou: no simulador a Rica encaminhou 3 de 3 vezes. Com 3 mil linhas de
 * prompt e os gatilhos G1-G6 empurrando para escalar, uma pergunta curta e
 * focada, feita no momento do encaminhamento, é muito mais confiável.
 *
 * Conservadora de propósito: só barra quem CLARAMENTE não é cliente. Na dúvida,
 * ou se a checagem falhar, o lead passa (perder lead custa mais que um aviso a
 * mais).
 */

import { generateObject } from 'ai'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'

export type Avaliacao = { ehLead: boolean; motivo: string }

// Validada em 06/10/2026 direto no modelo: caso Dado → false; padaria, oficina
// funcionando e negócio a abrir com capital próprio → true.
const INSTRUCAO = `Você avalia se quem conversa com a Rica, atendente da Sucesso no Resultado, é um CLIENTE POSSÍVEL.
A Sucesso é uma consultoria paga: ajuda empresas a vender mais e lucrar mais (consultoria,
diagnóstico, mentoria, treinamentos, a plataforma GPS e o app Alexy). Ela não empresta, não
doa, não financia e não fornece equipamentos.

Você recebe só as falas da pessoa. Decida pelo que ELA disse.

ehLead = true quando a pessoa:
- tem um negócio funcionando, de qualquer ramo (padaria, mercado, oficina, loja...); ou
- vai abrir um negócio e mostra que tem recurso próprio (ponto, capital, investimento reservado).

ehLead = false quando a pessoa:
- pede dinheiro, doação, empréstimo, financiamento, patrocínio ou que a empresa pague/compre algo para ela;
- ainda não tem o negócio E fala que lhe faltam o básico (terreno, equipamentos, dinheiro) sem mostrar recurso para contratar;
- procura emprego ou vaga;
- é engano, trote ou assunto sem relação com empresa.

Se nada disso estiver claro, ehLead = true.`

/**
 * Avalia as falas do lead (linhas "LEAD: ..."). Só as falas DELE: com as
 * respostas da Rica junto, que tratavam o caso Dado como "oficina", a checagem
 * aprovava. Nunca lança.
 */
export async function avaliarSeELead(falasDoLead: string): Promise<Avaliacao> {
  const log = logger.child({ fn: 'avaliarSeELead' })
  try {
    const { object } = await generateObject({
      model: openai(env.OPENAI_MODEL),
      temperature: 0,
      schema: z.object({
        ehLead: z.boolean(),
        motivo: z.string().describe('Uma frase curta, em português, explicando a decisão'),
      }),
      system: INSTRUCAO,
      prompt: `Falas do lead (mais recente no fim):\n\n${falasDoLead.slice(-12000)}`,
    })
    log.info(object, object.ehLead ? 'Porta do lead: é cliente possível' : '⛔ Porta do lead: não é cliente possível')
    return object
  } catch (err) {
    log.warn({ err }, 'Porta do lead falhou — deixando passar (fail-open)')
    return { ehLead: true, motivo: 'checagem indisponível' }
  }
}

/** O que a tool devolve à Rica quando a pessoa não é cliente possível. */
export function respostaNaoELead(motivo: string) {
  return {
    success: false,
    nao_e_lead: true,
    motivo,
    message:
      'NÃO ENCAMINHADO: esta pessoa não é um cliente possível da Sucesso (' + motivo + '). ' +
      'Não diga que passou os dados nem que alguém vai entrar em contato. ' +
      'Responda com gentileza que a Sucesso no Resultado é uma consultoria para empresas que já ' +
      'estão funcionando, que não fazemos financiamento, doação nem contratação, e deixe a porta ' +
      'aberta para quando ela tiver um negócio.',
  }
}
