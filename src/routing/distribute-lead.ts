/**
 * src/routing/distribute-lead.ts
 *
 * Distribuição de TODO lead novo (política da Malu): todo lead vai pra um
 * consultor, mesmo sem qualificar.
 *
 * - Produto identificável pela 1a mensagem → roteia pelo executive-router,
 *   notifica o executivo no WhatsApp + cópia pra Maria Helena + atribui no CRM.
 * - Produto NÃO identificável (ex: só "oi") → atribui à TRIAGEM (Malu) no CRM,
 *   sem notificação; ela distribui manualmente pelo CRM.
 *
 * Reusa o routeToExecutive/buildExecutiveMessage do notificar_equipe. O dedup
 * (Redis) evita notificar 2x o mesmo lead+produto se a Rica também escalar depois.
 */

import { routeToExecutive, buildExecutiveMessage, buildManagerMessage } from './executive-router.js'
import { EXECUTIVES } from './executives.config.js'
import { shouldNotify } from '../dedup/redis-incr.js'
import { crmRequest } from '../lib/crm-client.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { logger } from '../observability/logger.js'
import { env } from '../lib/env.js'

// Palavras-gatilho por produto (espelha o mapeamento do prompt). Conservador:
// só roteia/notifica quando há sinal claro de produto; resto vai pra triagem.
const PRODUCT_PATTERNS: Array<{ re: RegExp; produto: string }> = [
  { re: /\bgps\b/i, produto: 'GPS' },
  { re: /eneagrama|autoconhecimento/i, produto: 'Eneagrama' },
  { re: /\bjdl\b|jornada|lucratividade/i, produto: 'JDL' },
  { re: /treinamento|capacita[çc]|trilha|mentoria/i, produto: 'Treinamentos' },
  { re: /alexy/i, produto: 'App Alexy' },
  { re: /diagn[oó]stico|consultoria|planejamento (comercial|estrat)/i, produto: 'Consultoria' },
]

export function detectProduct(msg: string): string | null {
  const m = msg || ''
  for (const p of PRODUCT_PATTERNS) if (p.re.test(m)) return p.produto
  return null
}

export async function distributeNewLead(input: {
  phone: string
  leadName: string
  firstMessage: string
  dealId?: string | undefined
}): Promise<void> {
  if (!env.AUTO_DISTRIBUTE_ENABLED) return

  const log = logger.child({ fn: 'distributeNewLead', phone: input.phone.slice(-4) })
  const produto = detectProduct(input.firstMessage)

  // ── Sem produto identificável → triagem (Malu), só atribui no CRM ──────────
  if (!produto) {
    try {
      await crmRequest('/api/crm/deals/assign-owner-by-phone', {
        method: 'POST',
        body: {
          phone: input.phone,
          executivo_email: env.TRIAGE_EMAIL,
          assigned_via: 'auto_triagem',
          assigned_by: 'rica_ai',
        },
        operationName: 'assign_triagem',
      })
      log.info('Lead sem produto identificável → atribuído à triagem (Malu)')
    } catch (err) {
      log.warn({ err }, 'Falha ao atribuir lead à triagem')
    }
    return
  }

  // ── Produto identificável → roteia + notifica + atribui ────────────────────
  const canNotify = await shouldNotify(input.phone, produto).catch(() => true)
  if (!canNotify) {
    log.info({ produto }, 'Dedup: lead já distribuído recentemente — skip')
    return
  }

  const routing = routeToExecutive(produto, '', input.firstMessage, input.phone)
  const { executive, reason } = routing

  try {
    await sendWhatsApp(
      executive.phoneFormatted,
      buildExecutiveMessage({
        executiveName: executive.name,
        leadName: input.leadName,
        leadPhone: input.phone,
        leadCompany: '',
        leadEmail: '',
        product: produto,
        message: input.firstMessage,
        state: routing.state,
        ddd: routing.ddd,
      }),
    )
    if (executive.email !== EXECUTIVES.MARIA_HELENA.email) {
      await sendWhatsApp(
        EXECUTIVES.MARIA_HELENA.phoneFormatted,
        buildManagerMessage({
          leadName: input.leadName,
          product: produto,
          state: routing.state,
          ddd: routing.ddd,
          executiveName: executive.name,
          reason,
        }),
      )
    }
  } catch (err) {
    log.warn({ err }, 'Falha ao notificar executivo/gestora — segue para atribuir owner')
  }

  try {
    await crmRequest('/api/crm/deals/assign-owner-by-phone', {
      method: 'POST',
      body: {
        phone: input.phone,
        executivo_email: executive.email,
        assigned_via: 'auto_distribuicao',
        assigned_by: 'rica_ai',
      },
      operationName: 'assign_owner_auto',
    })
  } catch (err) {
    log.warn({ err }, 'Falha ao atribuir owner automático')
  }

  log.info({ executive: executive.name, produto }, 'Lead distribuído automaticamente')
}
