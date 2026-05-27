/**
 * src/observability/logger.ts
 *
 * Logger estruturado com pino.
 * JSON em produção, pretty em desenvolvimento.
 *
 * Em produção, todas as linhas também são gravadas num ring buffer
 * em memória (log-buffer.ts) exposto via GET /admin/logs.
 */

import pino, { type LoggerOptions } from 'pino'
import { logBufferStream } from './log-buffer.js'

const isDev = process.env['NODE_ENV'] !== 'production'
const logLevel = process.env['LOG_LEVEL'] ?? 'info'

const baseOptions: LoggerOptions = {
  level: logLevel,
  base: {
    service: 'rica-bot',
    env: process.env['NODE_ENV'] ?? 'development',
  },
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['*.token', '*.api_key', '*.apiKey', '*.password', '*.OPENAI_API_KEY'],
    censor: '[REDACTED]',
  },
}

// Em dev: pretty-print pra console.
// Em prod: JSON pra stdout + ring buffer (multistream).
export const logger = isDev
  ? pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '[{service}] {msg}',
          levelFirst: false,
        },
      },
    })
  : pino(
      baseOptions,
      pino.multistream([
        { stream: process.stdout },
        { stream: logBufferStream as unknown as NodeJS.WritableStream },
      ]),
    )

// ─── helpers de contexto ───────────────────────────────────────────────────

export function webhookLogger(phone: string, executionId?: string) {
  return logger.child({
    phone: phone.replace(/^55/, '').slice(-11),
    executionId,
    context: 'webhook',
  })
}

export function toolLogger(toolName: string, phone?: string) {
  return logger.child({
    tool: toolName,
    phone: phone?.replace(/^55/, '').slice(-11),
    context: 'tool',
  })
}

export function followupLogger(dealId?: string) {
  return logger.child({
    dealId,
    context: 'followup-worker',
  })
}
