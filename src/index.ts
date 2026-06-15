/**
 * src/index.ts — Entrypoint do rica-bot
 *
 * Sem canary release: 100% das mensagens são processadas pelo rica-bot.
 * Rollback de emergência = trocar webhook do uazapi de volta pro sistema antigo.
 */
import 'dotenv/config'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import cors from '@fastify/cors'
import { env } from './lib/env.js'
import { logger } from './observability/logger.js'
import { getPool, checkDbConnection, closePool } from './lib/db.js'
import { getMessageBuffer } from './buffer/message-buffer.js'
import { handleWebhook, handleBufferedMessage } from './webhook/handler.js'
import { startFollowupWorker } from './followup/worker.js'
import { startExecutiveFollowupWorker, closeExecutiveFollowup } from './followup/executive-followup.js'
import { startDailyDigestWorker, stopDailyDigestWorker } from './reports/daily-digest.js'
import { getAllMetrics, closeMetrics, incrementMetric } from './observability/metrics.js'
import { runPreflight } from './observability/preflight.js'
import { logBuffer } from './observability/log-buffer.js'

export async function buildApp() {
  const isDev = env.NODE_ENV !== 'production'

  const app = Fastify({
    logger: isDev
      ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,reqId,responseTime', messageFormat: '[rica-bot] {msg}' } } }
      : { level: env.LOG_LEVEL, base: { service: 'rica-bot' } },
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  })

  await app.register(sensible)
  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? env.UAZAPI_BASE_URL : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  })

  // ── health ──────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    service: 'rica-bot',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }))

  app.get('/ready', async (_, reply) => {
    const dbOk = await checkDbConnection()
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ready' : 'degraded',
      service: 'rica-bot',
      timestamp: new Date().toISOString(),
      checks: { postgres: dbOk ? 'ok' : 'error', redis: 'not_checked' },
    })
  })

  // ── observabilidade ─────────────────────────────────────────────────────────
  app.get('/metrics', async () => {
    const metrics = await getAllMetrics()
    return {
      timestamp: new Date().toISOString(),
      counters: metrics,
    }
  })

  app.get('/preflight', async (_, reply) => {
    const report = await runPreflight()
    return reply
      .code(report.overall === 'critical' ? 503 : 200)
      .send(report)
  })

  // ── /admin/logs — ring buffer dos últimos 2000 logs em memória ──────────
  //   ?limit=N    quantas linhas (default 200, max 2000)
  //   ?filter=X   substring case-insensitive
  //   ?format=text  (default) ou ?format=json
  // Header opcional: x-admin-token (obrigatório se ADMIN_TOKEN setado)
  app.get('/admin/logs', async (request, reply) => {
    if (env.ADMIN_TOKEN) {
      const token = request.headers['x-admin-token']
      if (token !== env.ADMIN_TOKEN) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }

    const q = request.query as { limit?: string; filter?: string; format?: string }
    const limit = Math.min(Math.max(parseInt(q.limit ?? '200', 10) || 200, 1), 2000)
    const filter = q.filter?.trim() || undefined
    const format = q.format ?? 'text'

    const lines = logBuffer.tail(limit, filter)

    if (format === 'json') {
      return reply.send({
        timestamp: new Date().toISOString(),
        total_in_buffer: logBuffer.size(),
        returned: lines.length,
        filter: filter ?? null,
        lines,
      })
    }

    // text/plain — mais fácil de ler no curl
    return reply
      .type('text/plain; charset=utf-8')
      .send(lines.join('\n') + '\n')
  })

  // ── webhook principal ───────────────────────────────────────────────────────
  app.post(env.UAZAPI_WEBHOOK_PATH, async (request, reply) => {
    void incrementMetric('webhook.received')

    try {
      await handleWebhook(request.body, { pool: getPool() })
      void incrementMetric('webhook.processed')
    } catch (err) {
      logger.error({ err }, 'Erro no handler do webhook')
      void incrementMetric('errors.webhook')
    }

    // Sempre responde 200 para o uazapi (evita retentativas)
    return reply.code(200).send({ status: 'ok' })
  })

  return app
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  try {
    // Inicia workers
    startFollowupWorker(getPool())
    startExecutiveFollowupWorker()
    startDailyDigestWorker(getPool())

    const buffer = getMessageBuffer()
    buffer.startWorker(async (msg) => {
      await handleBufferedMessage(msg, { pool: getPool() })
    })

    app = await buildApp()
    await app.listen({ port: env.PORT, host: '0.0.0.0' })

    logger.info({
      port: env.PORT,
      env: env.NODE_ENV,
      webhook: env.UAZAPI_WEBHOOK_PATH,
    }, '🚀 rica-bot iniciado')
  } catch (err) {
    logger.fatal({ error: err }, 'Falha na inicialização')
    process.exit(1)
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Encerrando...')
    try {
      await getMessageBuffer().close()
      stopDailyDigestWorker()
      await closeExecutiveFollowup()
      if (app) await app.close()
      await closePool()
      await closeMetrics()
      process.exit(0)
    } catch (err) {
      logger.error({ error: err }, 'Erro no shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('uncaughtException', (err) => { logger.fatal({ error: err }, 'Exceção não capturada'); process.exit(1) })
  process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'Promise não tratada'); process.exit(1) })
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('src/index.ts') ||
  process.argv[1]?.endsWith('dist/index.js')
) {
  void main()
}
