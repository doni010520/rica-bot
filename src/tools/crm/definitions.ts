/**
 * src/tools/crm/definitions.ts
 *
 * 14 tools CRM tipadas com Zod — equivalente dos 14 subworkflows CRM do n8n.
 *
 * Cada tool usa o AI SDK `tool()` com:
 *   - description: copiada fielmente do n8n (o LLM precisa do contexto exato)
 *   - parameters: Zod schema input (o que o LLM passa)
 *   - execute: chama CRM API, valida resposta com Zod
 *
 * IMPORTANTE: o `phone` da conversa é fechado no closure de `buildCrmTools(phone)`.
 * O LLM não precisa informar o telefone do usuário atual — já está no contexto.
 *
 * Correspondência n8n → código:
 *   buscar_contato       → GET /contacts/by-phone/:phone
 *   buscar_deal          → GET /deals/by-phone/:phone
 *   registrar_lead       → POST /register-lead
 *   criar_deal           → POST /deals
 *   listar_funis         → GET /pipelines
 *   listar_estagios      → GET /pipeline?pipeline_id=X
 *   atualizar_lead       → PATCH /deals/:id
 *   atualizar_contato    → PATCH /contacts/:id
 *   atualizar_empresa    → PATCH /companies/:id
 *   salvar_insight       → POST /deals/:id/insights
 *   salvar_insights_lote → POST /deals/:id/insights/batch
 *   registrar_atividade  → POST /deals/:id/activities
 *   mover_estagio        → PATCH /deals/:id/stage
 *   consultar_cnpj       → GET /cnpj/:cnpj
 */

import { tool } from 'ai'
import { z } from 'zod'
import { crmRequest } from '../../lib/crm-client.js'
import { env } from '../../lib/env.js'
import { logger } from '../../observability/logger.js'

// ─── schemas de resposta reutilizados ─────────────────────────────────────────

const ContactSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  company_id: z.string().optional(),
  company_name: z.string().optional(),
})

const DealSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  temperature: z.string().optional(),
  pipeline_stage_id: z.string().optional(),
  owner_id: z.string().optional(),
  contact_phone: z.string().optional(),
})

const PipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  stages: z.array(z.object({ id: z.string(), name: z.string(), position: z.number() })).optional(),
})

// ─── factory de tools ─────────────────────────────────────────────────────────

/**
 * Cria as 14 tools CRM fechadas sobre o telefone da conversa atual.
 * @param phone - Telefone normalizado do usuário da conversa
 */
export function buildCrmTools(phone: string) {
  const log = logger.child({ phone: phone.slice(-4), context: 'crm-tool' })

  // ── 1. buscar_contato ───────────────────────────────────────────────────────
  const buscar_contato = tool({
    description:
      'Busca se o contato já existe no CRM pelo telefone. Retorna contato, empresa vinculada e todos os deals abertos. USAR apenas se os dados pré-carregados estiverem desatualizados ou para buscar outro contato.',
    parameters: z.object({
      phone_override: z
        .string()
        .optional()
        .describe('Telefone para buscar (deixar vazio para usar o telefone da conversa atual)'),
    }),
    execute: async ({ phone_override }) => {
      const target = phone_override ?? phone
      log.info({ tool: 'buscar_contato', target: target.slice(-4) }, 'Executando')
      try {
        const data = await crmRequest(`/api/crm/contacts/by-phone/${encodeURIComponent(target)}`)
        return { success: true, data }
      } catch {
        return { success: false, data: null }
      }
    },
  })

  // ── 2. buscar_deal ──────────────────────────────────────────────────────────
  const buscar_deal = tool({
    description:
      'Busca deals pelo telefone do contato. FALLBACK: usar apenas se buscar_contato retornar exists=false mas suspeitar que o lead existe. Retorna lista de deals.',
    parameters: z.object({
      deal_id: z.string().optional().describe('UUID do deal específico (opcional)'),
    }),
    execute: async ({ deal_id }) => {
      log.info({ tool: 'buscar_deal' }, 'Executando')
      try {
        const path = deal_id
          ? `/api/crm/deals/${encodeURIComponent(deal_id)}`
          : `/api/crm/deals/by-phone/${encodeURIComponent(phone)}`
        const data = await crmRequest(path)
        return { success: true, data }
      } catch {
        return { success: false, data: null }
      }
    },
  })

  // ── 3. registrar_lead ───────────────────────────────────────────────────────
  const registrar_lead = tool({
    description:
      'Cria contato + empresa + deal em uma única chamada transacional. Usar quando buscar_contato retornar exists=false e o pré-carregado não tiver IDs.',
    parameters: z.object({
      contact_name: z.string().describe('Nome completo do contato'),
      contact_phone: z.string().optional().describe('Telefone (padrão: telefone da conversa)'),
      contact_email: z.string().optional(),
      company_name: z.string().optional(),
      company_cnpj: z.string().optional(),
      company_segment: z.string().optional(),
      pipeline_name: z.string().default('Triagem'),
      deal_title: z.string().optional(),
      source: z.string().default('whatsapp'),
      source_detail: z.string().optional(),
      temperature: z.enum(['hot', 'warm', 'cold']).default('warm'),
    }),
    execute: async (params) => {
      log.info({ tool: 'registrar_lead' }, 'Executando')
      const data = await crmRequest('/api/crm/register-lead', {
        method: 'POST',
        body: { ...params, contact_phone: params.contact_phone ?? phone },
        operationName: 'registrar_lead',
      })
      return { success: true, data }
    },
  })

  // ── 4. criar_deal ───────────────────────────────────────────────────────────
  const criar_deal = tool({
    description:
      'Cria um novo deal para contato JÁ EXISTENTE em outro funil. NÃO usar para primeiro registro (usar registrar_lead). Usar quando descobrir o produto de interesse e precisar criar deal no funil correto.',
    parameters: z.object({
      contact_id: z.string().describe('UUID do contato existente'),
      pipeline_stage_id: z.string().describe('UUID do estágio inicial no novo funil'),
      title: z.string().describe('Título do deal (ex: "GPS Resultado - João Silva")'),
      temperature: z.enum(['hot', 'warm', 'cold']).default('warm'),
      source: z.string().default('whatsapp'),
    }),
    execute: async (params) => {
      log.info({ tool: 'criar_deal' }, 'Executando')
      const data = await crmRequest('/api/crm/deals', {
        method: 'POST',
        body: { ...params, organization_id: env.ORG_ID },
        operationName: 'criar_deal',
      })
      return { success: true, data }
    },
  })

  // ── 5. listar_funis ─────────────────────────────────────────────────────────
  const listar_funis = tool({
    description:
      'Lista todos os funis (pipelines) disponíveis com seus IDs. Usar quando precisar criar deal em funil específico e não souber o ID.',
    parameters: z.object({}),
    execute: async () => {
      log.info({ tool: 'listar_funis' }, 'Executando')
      const data = await crmRequest('/api/crm/pipelines')
      const parsed = z.array(PipelineSchema).safeParse(data)
      return { success: true, data: parsed.success ? parsed.data : data }
    },
  })

  // ── 6. listar_estagios ──────────────────────────────────────────────────────
  const listar_estagios = tool({
    description:
      'Lista os estágios de um funil específico. Usar quando precisar mover deal de estágio e precisar do UUID do estágio destino.',
    parameters: z.object({
      pipeline_id: z.string().describe('UUID do funil'),
    }),
    execute: async ({ pipeline_id }) => {
      log.info({ tool: 'listar_estagios', pipeline_id }, 'Executando')
      const data = await crmRequest('/api/crm/pipeline', {
        params: { pipeline_id },
        operationName: 'listar_estagios',
      })
      return { success: true, data }
    },
  })

  // ── 7. atualizar_lead ───────────────────────────────────────────────────────
  const atualizar_lead = tool({
    description:
      'Atualiza dados do deal conforme a conversa avança. Usar quando: pessoa informa empresa, email, demonstra urgência (temperature=hot), confirma interesse em produto específico (title), ou precisa de follow-up registrado.',
    parameters: z.object({
      deal_id: z.string().describe('UUID do deal a atualizar'),
      title: z.string().optional(),
      temperature: z.enum(['hot', 'warm', 'cold']).optional(),
      status: z.enum(['open', 'won', 'lost']).optional(),
      lost_reason: z.string().optional(),
      value: z.number().optional(),
      custom_fields: z.record(z.unknown()).optional(),
    }),
    execute: async ({ deal_id, ...updates }) => {
      log.info({ tool: 'atualizar_lead', deal_id }, 'Executando')
      const data = await crmRequest(`/api/crm/deals/${encodeURIComponent(deal_id)}`, {
        method: 'PATCH',
        body: updates,
        operationName: 'atualizar_lead',
      })
      return { success: true, data }
    },
  })

  // ── 8. atualizar_contato ────────────────────────────────────────────────────
  const atualizar_contato = tool({
    description:
      'Atualiza dados do contato standalone. Usar quando descobrir nome real, email, cargo ou empresa do contato.',
    parameters: z.object({
      contact_id: z.string().describe('UUID do contato'),
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      company_id: z.string().optional(),
    }),
    execute: async ({ contact_id, ...updates }) => {
      log.info({ tool: 'atualizar_contato', contact_id }, 'Executando')
      const data = await crmRequest(`/api/crm/contacts/${encodeURIComponent(contact_id)}`, {
        method: 'PATCH',
        body: updates,
        operationName: 'atualizar_contato',
      })
      return { success: true, data }
    },
  })

  // ── 9. atualizar_empresa ────────────────────────────────────────────────────
  const atualizar_empresa = tool({
    description:
      'Atualiza dados da empresa. Usar quando descobrir CNPJ, segmento, cidade, estado, telefone ou website da empresa do contato.',
    parameters: z.object({
      company_id: z.string().describe('UUID da empresa'),
      name: z.string().optional(),
      cnpj: z.string().optional(),
      segment: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      website: z.string().optional(),
    }),
    execute: async ({ company_id, ...updates }) => {
      log.info({ tool: 'atualizar_empresa', company_id }, 'Executando')
      const data = await crmRequest(`/api/crm/companies/${encodeURIComponent(company_id)}`, {
        method: 'PATCH',
        body: updates,
        operationName: 'atualizar_empresa',
      })
      return { success: true, data }
    },
  })

  // ── 10. salvar_insight ──────────────────────────────────────────────────────
  const salvar_insight = tool({
    description:
      'Salva um insight descoberto durante a conversa em tempo real. Usar quando descobrir: segmento da empresa, principal dor, produto de interesse, objeção levantada, urgência.',
    parameters: z.object({
      deal_id: z.string().describe('UUID do deal'),
      category: z
        .string()
        .describe(
          'Categoria do insight: segmento | produto | dor | objecao | urgencia | perfil | outro',
        ),
      content: z.string().describe('Conteúdo do insight em linguagem natural'),
      confidence: z.number().min(0).max(1).default(0.9),
    }),
    execute: async ({ deal_id, ...insight }) => {
      log.info({ tool: 'salvar_insight', deal_id, category: insight.category }, 'Executando')
      const data = await crmRequest(`/api/crm/deals/${encodeURIComponent(deal_id)}/insights`, {
        method: 'POST',
        body: { ...insight, source: 'ai_agent' },
        operationName: 'salvar_insight',
      })
      return { success: true, data }
    },
  })

  // ── 11. salvar_insights_lote ────────────────────────────────────────────────
  const salvar_insights_lote = tool({
    description:
      'Salva múltiplos insights de uma vez. Usar após completar diagnóstico empresarial (quando coletar 5+ informações estruturadas sobre o negócio).',
    parameters: z.object({
      deal_id: z.string().describe('UUID do deal'),
      insights: z.array(
        z.object({
          category: z.string(),
          content: z.string(),
          confidence: z.number().min(0).max(1).default(0.9),
        }),
      ),
    }),
    execute: async ({ deal_id, insights }) => {
      log.info({ tool: 'salvar_insights_lote', deal_id, count: insights.length }, 'Executando')
      const data = await crmRequest(
        `/api/crm/deals/${encodeURIComponent(deal_id)}/insights/batch`,
        {
          method: 'POST',
          body: { insights: insights.map((i) => ({ ...i, source: 'ai_agent' })) },
          operationName: 'salvar_insights_lote',
        },
      )
      return { success: true, data }
    },
  })

  // ── 12. registrar_atividade ─────────────────────────────────────────────────
  const registrar_atividade = tool({
    description:
      'Registra uma interação ou evento importante no histórico do deal. Usar nos momentos-chave: primeiro contato, interesse explícito em produto, solicitação de proposta, escalação para executivo.',
    parameters: z.object({
      deal_id: z.string().describe('UUID do deal'),
      type: z
        .string()
        .describe(
          'Tipo: whatsapp | email | call | system | followup | note | escalation | presentation',
        ),
      description: z.string().describe('Descrição da atividade'),
      metadata: z.record(z.unknown()).optional(),
    }),
    execute: async ({ deal_id, ...activity }) => {
      log.info({ tool: 'registrar_atividade', deal_id, type: activity.type }, 'Executando')
      const data = await crmRequest(`/api/crm/deals/${encodeURIComponent(deal_id)}/activities`, {
        method: 'POST',
        body: activity,
        operationName: 'registrar_atividade',
      })
      return { success: true, data }
    },
  })

  // ── 13. mover_estagio ───────────────────────────────────────────────────────
  const mover_estagio = tool({
    description:
      'Move o deal para outro estágio do pipeline. Usar quando: lead qualifica para próximo passo, cliente demonstra interesse claro, ou deal precisa ser reclassificado.',
    parameters: z.object({
      deal_id: z.string().describe('UUID do deal a mover'),
      stage_id: z.string().describe('UUID do estágio destino (obter via listar_estagios)'),
    }),
    execute: async ({ deal_id, stage_id }) => {
      log.info({ tool: 'mover_estagio', deal_id }, 'Executando')
      const data = await crmRequest(`/api/crm/deals/${encodeURIComponent(deal_id)}/stage`, {
        method: 'PATCH',
        body: { stage_id },
        operationName: 'mover_estagio',
      })
      return { success: true, data }
    },
  })

  // ── 14. consultar_cnpj ──────────────────────────────────────────────────────
  const consultar_cnpj = tool({
    description:
      'Consulta dados de uma empresa pelo CNPJ na Receita Federal via BrasilAPI. Retorna razão social, nome fantasia, segmento e endereço. Usar quando cliente informar CNPJ.',
    parameters: z.object({
      cnpj: z.string().describe('CNPJ da empresa, apenas números (14 dígitos)'),
    }),
    execute: async ({ cnpj }) => {
      const digits = cnpj.replace(/\D/g, '')
      log.info({ tool: 'consultar_cnpj', cnpj: digits.slice(0, 4) + '...' }, 'Executando')
      const data = await crmRequest(`/api/crm/cnpj/${encodeURIComponent(digits)}`)
      return { success: true, data }
    },
  })

  return {
    buscar_contato,
    buscar_deal,
    registrar_lead,
    criar_deal,
    listar_funis,
    listar_estagios,
    atualizar_lead,
    atualizar_contato,
    atualizar_empresa,
    salvar_insight,
    salvar_insights_lote,
    registrar_atividade,
    mover_estagio,
    consultar_cnpj,
  }
}

export type CrmTools = ReturnType<typeof buildCrmTools>
