/**
 * src/crm/pre-fetch.ts
 *
 * Pre-fetch do CRM antes do agent — replica os nós:
 *   Pre_BuscarContato (GET /contacts/by-phone/:phone)
 *   IF_ContatoExiste
 *   Pre_RegistrarLead  (POST /register-lead — se não existe)
 *   Set_CRM_Existente / Set_CRM_Novo
 *
 * Retorna CrmContext que é injetado no system prompt e disponibilizado
 * para o agent como dados pré-carregados (evita que o LLM precise
 * chamar buscar_contato/listar_funis no primeiro turno).
 */

import { z } from 'zod'
import { crmRequest } from '../lib/crm-client.js'
import type { CrmContext } from '../agent/prompt.js'
import { logger } from '../observability/logger.js'

// ─── schemas de resposta ──────────────────────────────────────────────────────

const ContactResponseSchema = z.object({
  exists: z.boolean().optional(),
  contact: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      company_id: z.string().optional(),
      company_name: z.string().optional(),
    })
    .optional(),
  deals: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        status: z.string().optional(),
        pipeline_stage_id: z.string().optional(),
      }),
    )
    .optional(),
})

const RegisterLeadResponseSchema = z.object({
  contact: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  deal: z
    .object({
      id: z.string().optional(),
    })
    .optional(),
  company: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
})

// ─── função principal ─────────────────────────────────────────────────────────

/**
 * Busca ou cria o lead no CRM antes de iniciar o agent.
 *
 * Comportamento:
 * - Contato existe → retorna CrmContext com dados reais
 * - Contato não existe → cria em Triagem → retorna CrmContext com IDs novos
 * - CRM inacessível → retorna CrmContext vazio (agent opera sem dados pré-carregados)
 *
 * @param phone - Telefone normalizado do usuário
 * @param displayName - Nome exibido no WhatsApp (para registro inicial)
 */
/**
 * Retorna um nome REAL ou string vazia — NUNCA o telefone.
 * O WhatsApp às vezes manda o próprio número como "nome"; isso não é nome.
 */
export function cleanName(name: string | undefined | null, phone: string): string {
  const n = (name ?? '').trim()
  if (!n) return ''
  const nDigits = n.replace(/\D/g, '')
  const pDigits = phone.replace(/\D/g, '')
  // Só dígitos / pontuação de telefone, ou bate com o número → não é nome
  if (nDigits.length >= 8 && (nDigits === pDigits || /^[\d\s+().-]+$/.test(n))) return ''
  return n
}

/**
 * Detecta o funil já no primeiro contato — leads de campanha que chegam
 * dizendo o produto (ex: "quero saber da GPS Padaria") nascem no funil certo,
 * em vez de Triagem/Entrada de Leads. Ambíguos seguem 'Triagem' (a Rica
 * classifica durante a conversa).
 */
function detectPipelineName(firstMessage: string): string {
  const m = (firstMessage || '').toLowerCase()
  if (/\bgps\b/.test(m)) return 'GPS'
  return 'Triagem'
}

export async function preFetchCrm(phone: string, displayName: string, firstMessage = ''): Promise<CrmContext> {
  const log = logger.child({ phone: phone.slice(-4), fn: 'preFetchCrm' })
  const cleanedName = cleanName(displayName, phone)
  const pipelineName = detectPipelineName(firstMessage)

  // ── 1. Busca contato existente ──────────────────────────────────────────────
  try {
    const raw = await crmRequest(`/api/crm/contacts/by-phone/${encodeURIComponent(phone)}`)
    const parsed = ContactResponseSchema.safeParse(raw)

    if (!parsed.success) {
      log.warn({ zodError: parsed.error.issues }, 'Resposta do CRM não bateu com schema esperado')
    }

    const res = parsed.data ?? (raw as z.infer<typeof ContactResponseSchema>)

    // Contato encontrado
    if (res.contact?.id) {
      const openDeals = res.deals?.filter((d) => d.status === 'open') ?? []
      const primaryDeal = openDeals[0]

      log.info({ contactId: res.contact.id, openDeals: openDeals.length }, 'Contato encontrado no CRM')

      return {
        exists: true,
        contactId: res.contact.id,
        contactName: cleanName(res.contact.name, phone) || cleanedName || undefined,
        companyId: res.contact.company_id,
        companyName: res.contact.company_name,
        dealId: primaryDeal?.id,
        openDeals: JSON.stringify(openDeals),
        phone,
      }
    }

    // Resposta 200 mas sem contato → cria novo
    log.info('Contato não encontrado — registrando lead')
  } catch (err) {
    const isNotFound = err instanceof Error && err.message.includes('404')
    if (!isNotFound) {
      log.warn({ err }, 'Erro ao buscar contato — continuando sem dados CRM')
      return { exists: false, phone }
    }
    log.info('404 — contato não existe, criando')
  }

  // ── 2. Registra lead novo em Triagem ───────────────────────────────────────
  try {
    const raw = await crmRequest('/api/crm/register-lead', {
      method: 'POST',
      body: {
        contact_name: cleanedName || undefined,
        contact_phone: phone,
        pipeline_name: pipelineName,
        deal_title: `Lead WhatsApp - ${cleanedName || phone}`,
        source: 'whatsapp',
        temperature: 'warm',
      },
      operationName: 'pre_registrar_lead',
    })

    const parsed = RegisterLeadResponseSchema.safeParse(raw)
    const res = parsed.data ?? (raw as z.infer<typeof RegisterLeadResponseSchema>)

    log.info({ contactId: res.contact?.id, dealId: res.deal?.id }, 'Lead registrado em Triagem')

    return {
      exists: false,
      contactId: res.contact?.id,
      contactName: cleanedName || undefined,
      companyId: res.company?.id,
      companyName: res.company?.name,
      dealId: res.deal?.id,
      openDeals: res.deal?.id ? JSON.stringify([{ id: res.deal.id, title: `Lead WhatsApp - ${cleanedName || phone}`, status: 'open' }]) : '[]',
      phone,
    }
  } catch (err) {
    log.error({ err }, 'Falha ao registrar lead — agent sem contexto CRM')
    return { exists: false, phone }
  }
}
