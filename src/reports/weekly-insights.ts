/**
 * src/reports/weekly-insights.ts
 *
 * Análise semanal de gargalos — a Rica lê o funil e as conversas, identifica
 * ONDE os leads estão morrendo e sugere melhorias. Envia no WhatsApp da gestora.
 *
 * Cron semanal (default segunda 08h BRT). Diferente do resumo diário (factual),
 * aqui é um diagnóstico ACIONÁVEL gerado por LLM em cima de dados reais.
 */

import cron from 'node-cron'
import type { Pool } from 'pg'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { EXECUTIVES } from '../routing/executives.config.js'

let _cronTask: ReturnType<typeof cron.schedule> | null = null

// ─── coleta de dados ──────────────────────────────────────────────────────────

async function gatherData(pool: Pool) {
  const org = env.ORG_ID

  const [funil, perdas, etapas, dropoff, exemplos] = await Promise.all([
    pool.query(
      `SELECT
         count(*) FILTER (WHERE source='whatsapp' AND created_at >= now() - interval '7 days') AS novos_7d,
         count(*) FILTER (WHERE status='won'  AND won_date  >= now() - interval '7 days') AS ganhos_7d,
         count(*) FILTER (WHERE status='lost' AND lost_date >= now() - interval '7 days') AS perdidos_7d,
         count(*) FILTER (WHERE status='open' AND owner_id IS NULL) AS sem_dono,
         count(*) FILTER (WHERE status='open') AS abertos
       FROM deals WHERE organization_id = $1`,
      [org],
    ),
    pool.query(
      `SELECT COALESCE(lost_reason,'(sem motivo registrado)') AS motivo, count(*) AS n
       FROM deals WHERE organization_id = $1 AND status='lost' AND lost_date >= now() - interval '30 days'
       GROUP BY lost_reason ORDER BY n DESC LIMIT 5`,
      [org],
    ),
    pool.query(
      `SELECT COALESCE(ps.name,'(sem etapa)') AS etapa, count(*) AS leads,
              round(avg(EXTRACT(EPOCH FROM (now()-d.stage_entered_at))/86400)::numeric,1) AS dias_parado_medio
       FROM deals d LEFT JOIN pipeline_stages ps ON ps.id = d.pipeline_stage_id
       WHERE d.organization_id = $1 AND d.status='open'
       GROUP BY ps.name ORDER BY leads DESC LIMIT 8`,
      [org],
    ),
    pool.query(
      `WITH recent AS (
         SELECT DISTINCT contact_phone FROM deals
         WHERE organization_id = $1 AND source='whatsapp'
           AND created_at >= now() - interval '14 days' AND contact_phone IS NOT NULL
       ), conv AS (
         SELECT h.session_id, count(*) FILTER (WHERE h.message->>'type'='human') AS humanas
         FROM n8n_chat_histories h JOIN recent r ON r.contact_phone = h.session_id
         GROUP BY h.session_id
       )
       SELECT count(*) AS total,
              count(*) FILTER (WHERE humanas <= 1) AS so_abertura,
              count(*) FILTER (WHERE humanas BETWEEN 2 AND 4) AS engajou_pouco,
              count(*) FILTER (WHERE humanas >= 5) AS engajou
       FROM conv`,
      [org],
    ),
    pool.query(
      `WITH recent AS (
         SELECT DISTINCT contact_phone FROM deals
         WHERE organization_id = $1 AND source='whatsapp'
           AND created_at >= now() - interval '14 days' AND contact_phone IS NOT NULL
       ), mortas AS (
         SELECT h.session_id
         FROM n8n_chat_histories h JOIN recent r ON r.contact_phone = h.session_id
         GROUP BY h.session_id
         HAVING count(*) FILTER (WHERE h.message->>'type'='human') <= 1
         LIMIT 3
       )
       SELECT (SELECT left(h2.message->'data'->>'content', 280)
               FROM n8n_chat_histories h2
               WHERE h2.session_id = mortas.session_id AND h2.message->>'type'='ai'
               ORDER BY h2.id ASC LIMIT 1) AS primeira_resposta_rica
       FROM mortas`,
      [org],
    ),
  ])

  return {
    periodo: 'últimos 7 dias (conversas: últimos 14)',
    funil: funil.rows[0],
    perdas_30d: perdas.rows,
    leads_parados_por_etapa: etapas.rows,
    conversas: dropoff.rows[0],
    exemplos_de_conversas_que_morreram: exemplos.rows.map((r) => r.primeira_resposta_rica).filter(Boolean),
  }
}

// ─── análise via LLM ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a PRÓPRIA RICA analisando o seu próprio desempenho da semana — é VOCÊ quem conversa com os leads no WhatsApp. Você recebe métricas reais do funil e exemplos das SUAS conversas, e escreve, em PRIMEIRA PESSOA, um diagnóstico CURTO e ACIONÁVEL para a sua gestora.

Foque em três coisas:
1. ONDE os leads estão morrendo nas MINHAS conversas e no funil.
2. Os 2-3 maiores gargalos do MEU atendimento.
3. SUGESTÕES concretas do que EU poderia mudar no meu jeito de atender (ajustes no MEU comportamento/prompt) pra os leads evoluírem mais — pra a gestora aprovar.

Regras:
- Português do Brasil, PRIMEIRA PESSOA ("eu"), tom direto, SEM jargão técnico.
- Formato WhatsApp: use *negrito* nos títulos. Nada de tabela.
- Curto — cabe numa tela de celular.
- Baseie-se SOMENTE nos dados recebidos. NUNCA invente números.`

async function generateInsights(data: unknown): Promise<string> {
  try {
    const result = await generateText({
      model: openai(env.OPENAI_MODEL),
      temperature: 0.4,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Dados da semana (JSON):\n${JSON.stringify(data, null, 2)}\n\nEscreva o diagnóstico de gargalos com sugestões para a gestora.`,
        },
      ],
    })
    return result.text?.trim() ?? ''
  } catch (err) {
    logger.error({ err }, 'Falha no LLM da análise semanal')
    return ''
  }
}

// ─── execução ───────────────────────────────────────────────────────────────────

export async function runWeeklyInsights(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'weekly-insights' })
  try {
    const data = await gatherData(pool)
    const analise = await generateInsights(data)
    if (!analise) {
      log.warn('Análise vazia — não enviada')
      return
    }
    const msg = `🔎 *Rica — Análise da semana (gargalos)*\n\n${analise}`
    await sendWhatsApp(EXECUTIVES.MARIA_HELENA.phoneFormatted, msg)
    log.info('Análise semanal de gargalos enviada à gestora')
  } catch (err) {
    log.error({ err }, 'Falha ao gerar/enviar a análise semanal')
  }
}

// ─── agendamento ────────────────────────────────────────────────────────────────

export function startWeeklyInsightsWorker(pool: Pool): void {
  if (_cronTask) {
    logger.warn('Weekly insights worker já está rodando')
    return
  }
  if (!env.INSIGHTS_ENABLED) {
    logger.info('Weekly insights desabilitado — skip')
    return
  }
  _cronTask = cron.schedule(
    env.INSIGHTS_CRON,
    async () => {
      await runWeeklyInsights(pool)
    },
    { timezone: env.FOLLOWUP_TIMEZONE, scheduled: true },
  )
  logger.info({ cron: env.INSIGHTS_CRON, timezone: env.FOLLOWUP_TIMEZONE }, '📅 Weekly insights worker iniciado')
}

export function stopWeeklyInsightsWorker(): void {
  _cronTask?.stop()
  _cronTask = null
}
