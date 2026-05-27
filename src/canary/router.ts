/**
 * src/canary/router.ts
 *
 * Roteamento canary entre rica-bot e n8n.
 *
 * ESTRATÉGIA:
 * - Hash do telefone mod 100 < CANARY_PERCENTAGE → processa no rica-bot
 * - Hash do telefone mod 100 >= CANARY_PERCENTAGE → forward para n8n
 *
 * Por que hash do telefone (não random)?
 * → Mesmo telefone SEMPRE vai para o mesmo sistema durante a transição.
 * → Conversas não ficam particionadas entre os dois sistemas.
 * → Rollback instantâneo: mudar % → todos os novos requests seguem o novo %.
 *
 * FLUXO DE AUMENTO RECOMENDADO:
 *   CANARY_PERCENTAGE=0   → 100% n8n (deploy validado, sem tráfego real)
 *   CANARY_PERCENTAGE=10  → 10% rica-bot, validar logs 1-2 horas
 *   CANARY_PERCENTAGE=25  → ampliar se métricas ok
 *   CANARY_PERCENTAGE=50  → metade/metade, comparar comportamento
 *   CANARY_PERCENTAGE=75  → maioria no rica-bot
 *   CANARY_PERCENTAGE=100 → 100% rica-bot, desligar n8n após 30 dias
 */

import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { incrementMetric } from '../observability/metrics.js'

export type CanaryDecision = 'rica-bot' | 'n8n'

/** Hash simples do telefone → 0..99 */
export function phoneHash(phone: string): number {
  const digits = phone.replace(/\D/g, '')
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    sum += (parseInt(digits[i] ?? '0', 10) + 1) * (i + 1)
  }
  return sum % 100
}

/**
 * Lógica pura de canary — testável sem depender do singleton env.
 * @param phone - Telefone do lead
 * @param percentage - Percentual para rica-bot (0-100)
 */
export function canaryDecide(phone: string, percentage: number): CanaryDecision {
  if (percentage === 0) return 'n8n'
  if (percentage === 100) return 'rica-bot'
  return phoneHash(phone) < percentage ? 'rica-bot' : 'n8n'
}

/**
 * Decide se a mensagem de um telefone deve ser processada pelo rica-bot ou n8n.
 * Determinístico: mesmo telefone → mesmo sistema.
 */
export function getCanaryDecision(phone: string): CanaryDecision {
  const decision = canaryDecide(phone, env.CANARY_PERCENTAGE)
  logger.debug({ phone: phone.slice(-4), percentage: env.CANARY_PERCENTAGE, decision }, 'Canary decision')
  return decision
}

/**
 * Faz forward do payload original para o n8n.
 * Usado quando canary decide que a mensagem vai para o n8n.
 */
export async function forwardToN8n(rawBody: unknown): Promise<void> {
  const n8nUrl = env.N8N_WEBHOOK_URL
  if (!n8nUrl) {
    logger.warn('N8N_WEBHOOK_URL não configurada — mensagem descartada no forward')
    return
  }

  try {
    const res = await fetch(n8nUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rawBody),
      signal: AbortSignal.timeout(10_000),
    })

    void incrementMetric('canary.forwarded_to_n8n')

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Forward para n8n retornou não-ok')
    }
  } catch (err) {
    logger.error({ err }, 'Falha ao fazer forward para n8n')
    void incrementMetric('canary.forward_error')
  }
}

/** @internal - use phoneHash exported above */
