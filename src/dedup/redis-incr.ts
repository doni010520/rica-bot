/**
 * src/dedup/redis-incr.ts
 *
 * Deduplicação de notificações via Redis INCR + TTL.
 * Replica o mecanismo "Dedup INCR" do notificar_equipe do n8n.
 *
 * PROBLEMA que resolve: Rica pode chamar notificar_equipe múltiplas vezes
 * para o mesmo lead no mesmo intervalo (duplicação de notificações documentada).
 *
 * SOLUÇÃO: chave `dedup:notif:{phone}:{product}` com TTL de 1 hora.
 * Se a chave já existe → skip. Se não existe → cria + notifica.
 */

import IORedis from 'ioredis'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'

let _redis: IORedis | null = null

function getRedis(): IORedis {
  if (!_redis) {
    _redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 })
    _redis.on('error', (err) => logger.warn({ err }, 'Dedup Redis error'))
  }
  return _redis
}

/**
 * Verifica se a notificação já foi enviada recentemente.
 * Retorna true se DEVE notificar (primeira vez ou TTL expirado).
 * Retorna false se já foi notificado (dedup ativo).
 *
 * @param phone - Telefone do lead
 * @param product - Produto/serviço (para diferenciar escalações diferentes do mesmo lead)
 * @param ttlSeconds - Janela de dedup (default: env.DEDUP_TTL_SECONDS = 3600)
 */
export async function shouldNotify(
  phone: string,
  product: string,
  ttlSeconds = env.DEDUP_TTL_SECONDS,
): Promise<boolean> {
  const key = buildDedupKey(phone, product)

  try {
    const redis = getRedis()
    // INCR retorna o novo valor. Se for 1 → primeira vez → notificar
    const count = await redis.incr(key)

    if (count === 1) {
      // Primeira vez: define TTL
      await redis.expire(key, ttlSeconds)
      logger.debug({ key, count }, 'Dedup: primeira notificação — permitindo')
      return true
    }

    logger.info({ key, count, ttlSeconds }, 'Dedup: já notificado — bloqueando')
    return false
  } catch (err) {
    // Fail-open: se Redis estiver down, permite a notificação
    logger.warn({ err, key }, 'Dedup Redis indisponível — fail-open')
    return true
  }
}

/** Limpa manualmente o dedup de um lead (útil em testes ou reset manual) */
export async function clearDedup(phone: string, product: string): Promise<void> {
  const key = buildDedupKey(phone, product)
  try {
    await getRedis().del(key)
  } catch {
    // ignora
  }
}

function buildDedupKey(phone: string, product: string): string {
  const cleanPhone = phone.replace(/\D/g, '').slice(-8) // últimos 8 dígitos
  const cleanProduct = product.toLowerCase().replace(/\s+/g, '_').slice(0, 20)
  return `dedup:notif:${cleanPhone}:${cleanProduct}`
}

export async function closeDedup(): Promise<void> {
  if (_redis) { await _redis.quit(); _redis = null }
}
