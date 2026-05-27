/**
 * src/observability/metrics.ts
 *
 * Métricas simples via Redis counters.
 * Sem Prometheus por enquanto — apenas contadores incrementais
 * consultáveis via endpoint /metrics.
 *
 * Counters mantidos:
 *   webhook.received     — total de webhooks recebidos
 *   webhook.processed    — processados com sucesso
 *   webhook.ignored      — fromMe, revoke, grupos, etc.
 *   agent.calls          — chamadas ao LLM
 *   agent.fallbacks      — respostas vazias → fallback
 *   tools.{name}         — chamadas por tool
 *   followup.sent        — follow-ups enviados
 *   errors.{context}     — erros por contexto
 */

import IORedis from 'ioredis'
import { env } from '../lib/env.js'
import { logger } from './logger.js'

const METRICS_PREFIX = 'rica:metrics:'
const METRICS_TTL = 60 * 60 * 24 * 7 // 7 dias

let _redis: IORedis | null = null

function getRedis(): IORedis | null {
  if (!_redis) {
    try {
      _redis = new IORedis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
      })
      _redis.on('error', () => { /* silencia — métricas não são críticas */ })
    } catch {
      return null
    }
  }
  return _redis
}

/** Incrementa um contador. Fire-and-forget. */
export async function incrementMetric(key: string, amount = 1): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    const fullKey = `${METRICS_PREFIX}${key}`
    await redis.incrby(fullKey, amount)
    await redis.expire(fullKey, METRICS_TTL)
  } catch {
    // Métricas nunca crasham o fluxo principal
  }
}

/** Lê todos os counters de métricas para o endpoint /metrics. */
export async function getAllMetrics(): Promise<Record<string, number>> {
  const redis = getRedis()
  if (!redis) return { error: 1, message: 0 }

  try {
    const keys = await redis.keys(`${METRICS_PREFIX}*`)
    if (keys.length === 0) return {}

    const values = await redis.mget(...keys)
    const result: Record<string, number> = {}

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]?.replace(METRICS_PREFIX, '') ?? ''
      result[key] = parseInt(values[i] ?? '0', 10)
    }

    return result
  } catch (err) {
    logger.warn({ err }, 'Falha ao ler métricas')
    return {}
  }
}

export async function closeMetrics(): Promise<void> {
  if (_redis) { await _redis.quit(); _redis = null }
}
