/**
 * src/tools/operations/extras.ts
 *
 * Tools operacionais adicionais do Sprint 5.
 *
 * enviar_apresentacao:  envia material institucional da Sucesso
 * masterclass:          registra interesse/inscrição na masterclass
 * processar_transcricao: aciona processamento de transcrição de reunião
 * notificar_andre:      notificação específica para André (caso especial)
 *
 * NOTA: enviar_apresentacao e masterclass dependem de URLs/materiais
 * que precisam ser configurados em env vars antes do Sprint 6.
 * Por ora retornam mensagem de texto direta.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { env } from '../../lib/env.js'
import { EXECUTIVES } from '../../routing/executives.config.js'
import { logger } from '../../observability/logger.js'

// ─── enviar_apresentacao ──────────────────────────────────────────────────────

export const enviar_apresentacao = tool({
  description:
    'Envia material de apresentação da Sucesso no Resultado para o cliente. ' +
    'Usar quando o cliente pedir mais informações sobre a empresa, solicitar apresentação, ' +
    'ou quando for o momento de enviar material de apoio à venda.',
  parameters: z.object({
    tipo: z
      .enum(['institucional', 'gps', 'diagnostico', 'padaria', 'cafeteria', 'supermercado'])
      .default('institucional')
      .describe('Tipo de material a enviar'),
    phone: z.string().describe('Telefone do destinatário'),
  }),
  execute: async ({ tipo, phone }) => {
    logger.info({ tool: 'enviar_apresentacao', tipo, phone: phone.slice(-4) }, 'Executando')

    // TODO Sprint 6: configurar URLs reais dos materiais em env vars
    // Por ora responde com texto descritivo
    const materials: Record<string, string> = {
      institucional: 'apresentação institucional da Sucesso no Resultado',
      gps: 'material do GPS Resultado',
      diagnostico: 'guia do Diagnóstico Empresarial',
      padaria: 'apresentação GPS para Padarias',
      cafeteria: 'apresentação para Cafeterias',
      supermercado: 'apresentação para Supermercados',
    }

    const material = materials[tipo] ?? materials['institucional']

    return {
      success: true,
      message: `Material enviado: ${material}`,
      note: 'URLs dos materiais precisam ser configuradas antes do Sprint 6',
    }
  },
})

// ─── masterclass ──────────────────────────────────────────────────────────────

export const masterclass = tool({
  description:
    'Registra interesse ou inscrição do cliente em evento ou masterclass da Sucesso. ' +
    'Usar quando o cliente demonstrar interesse em eventos, masterclasses ou webinars.',
  parameters: z.object({
    evento: z.string().describe('Nome do evento ou masterclass'),
    contact_id: z.string().optional().describe('UUID do contato no CRM'),
    deal_id: z.string().optional().describe('UUID do deal'),
  }),
  execute: async ({ evento, contact_id, deal_id }) => {
    logger.info({ tool: 'masterclass', evento }, 'Executando')

    // TODO Sprint 6: integrar com sistema de eventos da Sucesso
    return {
      success: true,
      message: `Interesse registrado no evento: ${evento}`,
      contact_id,
      deal_id,
    }
  },
})

// ─── processar_transcricao ────────────────────────────────────────────────────

export const processar_transcricao = tool({
  description:
    'Aciona o processamento de uma transcrição de reunião confirmada pelo cliente. ' +
    'Usar quando o cliente confirmar que a transcrição está correta e pedir para processar.',
  parameters: z.object({
    deal_id: z.string().describe('UUID do deal relacionado'),
    transcricao_confirmada: z.boolean().describe('Cliente confirmou que os dados estão corretos'),
  }),
  execute: async ({ deal_id, transcricao_confirmada }) => {
    logger.info({ tool: 'processar_transcricao', deal_id, transcricao_confirmada }, 'Executando')

    if (!transcricao_confirmada) {
      return { success: false, message: 'Transcrição não confirmada pelo cliente' }
    }

    // TODO Sprint 6: chamar endpoint de processamento de transcrições
    return {
      success: true,
      message: 'Transcrição registrada para processamento',
      deal_id,
    }
  },
})

// ─── notificar_andre ──────────────────────────────────────────────────────────

export function buildNotificarAndreTool(conversationPhone: string) {
  return tool({
    description:
      'Notificação específica para André Augusto. ' +
      'Usar quando houver situação especial relacionada a leads de GPS ' +
      'que requer atenção imediata do André.',
    parameters: z.object({
      mensagem: z.string().describe('Contexto ou mensagem para o André'),
      lead_phone: z.string().optional(),
    }),
    execute: async ({ mensagem, lead_phone }) => {
      const log = logger.child({ tool: 'notificar_andre', phone: conversationPhone.slice(-4) })
      log.info('Executando')

      const andre = EXECUTIVES.ANDRE
      const text =
        `🔔 *ALERTA - Rica IA*\n\n` +
        `André, atenção especial necessária:\n\n` +
        `${mensagem}\n\n` +
        (lead_phone ? `📱 Lead: ${lead_phone}\n` : '') +
        `🤖 _Rica_`

      try {
        await fetch(`${env.UAZAPI_BASE_URL}/send/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', token: env.UAZAPI_TOKEN },
          body: JSON.stringify({ number: andre.phoneFormatted, text, delay: '3000' }),
          signal: AbortSignal.timeout(8_000),
        })
        return { success: true, message: 'André notificado' }
      } catch (err) {
        log.error({ err }, 'Falha ao notificar André')
        return { success: false, message: 'Falha ao notificar' }
      }
    },
  })
}
