/**
 * src/tools/operations/designar-lead.ts
 *
 * Tool designar_lead — encaminha lead para executivo ESPECÍFICO.
 *
 * Usado quando: (a) membro da equipe pede pra direcionar um lead, ou
 * (b) o próprio lead menciona um executivo pelo nome.
 * Diferente de notificar_equipe (roteamento automático por produto).
 *
 * É só a casca da tool: delega ao NÚCLEO ÚNICO (routing/encaminhar-lead) — o
 * mesmo que o copiloto usa. Uma Rica, um recurso, dois pontos de entrada.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { encaminharLead } from '../../routing/encaminhar-lead.js'

export function buildDesignarLeadTool(conversationPhone: string) {
  return tool({
    description:
      'Encaminha lead para um executivo ESPECÍFICO. Usar quando alguém da equipe pedir para ' +
      'direcionar um lead (ex: "manda pro André", "é pra Helen") OU quando o próprio lead ' +
      'mencionar um executivo (ex: "me indicaram o André"). ' +
      'IMPORTANTE: quem está na conversa pode ser da EQUIPE — o lead é outra pessoa (telefone informado).',
    parameters: z.object({
      executivo_mencionado: z.string().describe('Nome do executivo mencionado (ex: "Helen", "André Augusto")'),
      nome_lead: z.string().describe('Nome do lead'),
      telefone_lead: z.string().describe('Telefone do lead'),
      produto: z.string().optional().describe('Produto de interesse'),
      mensagem: z.string().optional().describe('Contexto da conversa'),
      deal_id: z.string().optional().describe('UUID do deal'),
    }),
    execute: async ({ executivo_mencionado, nome_lead, telefone_lead, produto, mensagem, deal_id }) => {
      const r = await encaminharLead({
        telefone: telefone_lead,
        nome: nome_lead,
        produto,
        mensagem,
        executivo: executivo_mencionado,
        dealId: deal_id,
        solicitante: 'rica_ai',
      })

      if (!r.success) {
        return { success: false, message: r.errorMessage ?? 'Não consegui encaminhar o lead.' }
      }
      return { success: true, executive: r.executiveName, message: `Designado para ${r.executiveName}` }
    },
  })
}
