/**
 * src/observability/logger.ts
 *
 * Logger estruturado com pino.
 * JSON em produção, pretty em desenvolvimento.
 */

import pino, { type LoggerOptions } from 'pino'

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

if (isDev) {
  baseOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
      messageFormat: '[{service}] {msg}',
      levelFirst: false,
    },
  }
}

export const logger = pino(baseOptions)

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
