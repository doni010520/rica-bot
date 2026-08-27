/**
 * src/lib/crm-client.ts
 *
 * Cliente HTTP base para o CRM API próprio da Sucesso.
 * Todas as 14 tools CRM usam este cliente.
 *
 * Autenticação: query param `organization_id` (mesmo padrão do n8n) + header
 * `x-service-token` quando CRM_SERVICE_TOKEN estiver preenchida (o CRM passa a
 * exigir o token para aceitar o acesso por organization_id).
 * Base URL: env.CRM_API_URL (configurar por ambiente).
 */

import { env } from './env.js'
import { withRetry } from './retry.js'
import { logger } from '../observability/logger.js'

/**
 * Headers padrão de toda chamada ao CRM.
 * O `x-service-token` só é enviado se CRM_SERVICE_TOKEN estiver configurada —
 * mantém compatibilidade com o CRM antes do rollout do SERVICE_API_KEY.
 * NUNCA usar estes headers para uazapi ou OpenAI.
 */
export function crmHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(env.CRM_SERVICE_TOKEN ? { 'x-service-token': env.CRM_SERVICE_TOKEN } : {}),
    ...extra,
  }
}

export class CrmApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'CrmApiError'
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Params de query adicionais (org_id já incluído automaticamente) */
  params?: Record<string, string>
  /** Nome da operação para logging */
  operationName?: string
  /** Timeout em ms (default 10s) — copiloto usa mais, pois roda LLM */
  timeoutMs?: number
}

/**
 * Faz requisição ao CRM API com retry automático.
 * Lança CrmApiError em respostas não-2xx.
 */
export async function crmRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, params = {}, operationName = path, timeoutMs = 10_000 } = opts

  const url = new URL(`${env.CRM_API_URL}${path}`)
  url.searchParams.set('organization_id', env.ORG_ID)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }

  return withRetry(
    async () => {
      const res = await fetch(url.toString(), {
        method,
        headers: crmHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}))
        logger.warn({ path, method, status: res.status, errorBody }, 'CRM API error')
        throw new CrmApiError(`CRM ${method} ${path} → ${res.status}`, res.status, errorBody)
      }

      const data = await res.json() as T
      return data
    },
    {
      attempts: 3,
      operationName: `crm_${operationName}`,
      isRetryable: (err) => {
        if (err instanceof CrmApiError) return err.status >= 500
        return true
      },
    },
  )
}
