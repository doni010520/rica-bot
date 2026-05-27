/**
 * src/lib/retry.ts
 *
 * Retry com backoff exponencial para chamadas HTTP ao CRM e uazapi.
 *
 * No n8n, falhas em chamadas HTTP ficavam sem retry e quebravam o fluxo
 * silenciosamente. Aqui centralizamos a lógica de retry com logs estruturados.
 */

import { logger } from '../observability/logger.js'

// ─── tipos ──────────────────────────────────────────────────────────────────

export type RetryOptions = {
  /** Número máximo de tentativas (default: 3) */
  attempts?: number
  /** Delay inicial em ms (default: 500) */
  initialDelayMs?: number
  /** Multiplicador do delay a cada tentativa (default: 2) */
  backoffFactor?: number
  /** Delay máximo em ms (default: 10000) */
  maxDelayMs?: number
  /** Nome da operação para logging */
  operationName?: string
  /** Função que decide se o erro é retryável (default: sempre) */
  isRetryable?: (error: unknown) => boolean
}

// ─── função principal ────────────────────────────────────────────────────────

/**
 * Executa uma função com retry e backoff exponencial.
 *
 * @example
 * const result = await withRetry(
 *   () => fetch('https://api.crm/...'),
 *   { attempts: 3, operationName: 'crm_buscar_contato' }
 * )
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    initialDelayMs = 500,
    backoffFactor = 2,
    maxDelayMs = 10_000,
    operationName = 'unknown',
    isRetryable = () => true,
  } = options

  let lastError: unknown
  let delay = initialDelayMs

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn()
      if (attempt > 1) {
        logger.info({ operationName, attempt }, 'Retry bem-sucedido')
      }
      return result
    } catch (error) {
      lastError = error

      if (!isRetryable(error)) {
        logger.warn(
          { operationName, attempt, error: formatError(error) },
          'Erro não retryável — abortando',
        )
        throw error
      }

      if (attempt === attempts) {
        logger.error(
          { operationName, attempt, attempts, error: formatError(error) },
          'Todas as tentativas falharam',
        )
        break
      }

      logger.warn(
        { operationName, attempt, attempts, delayMs: delay, error: formatError(error) },
        `Tentativa ${attempt}/${attempts} falhou — aguardando ${delay}ms`,
      )

      await sleep(delay)
      delay = Math.min(delay * backoffFactor, maxDelayMs)
    }
  }

  throw lastError
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Verifica se um erro é um erro HTTP de servidor (5xx) — retryável */
export function isServerError(error: unknown): boolean {
  if (error instanceof Error && 'status' in error) {
    const status = (error as { status: number }).status
    return status >= 500 && status < 600
  }
  return false
}

/** Verifica se é um erro de rede (timeout, connection refused) */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset')
  )
}

/** Erros retryáveis padrão (rede + 5xx) */
export function isRetryableByDefault(error: unknown): boolean {
  return isNetworkError(error) || isServerError(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join(' | '),
    }
  }
  return { raw: String(error) }
}
