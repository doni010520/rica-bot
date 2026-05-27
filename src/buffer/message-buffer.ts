/**
 * src/buffer/message-buffer.ts
 *
 * Buffer de mensagens fragmentadas — equivalente do Redis4/Wait5/Redis5/If3 do n8n.
 *
 * Usa BullMQ com connection string (não instância IORedis) para evitar
 * conflito de versões entre ioredis e bullmq/node_modules/ioredis.
 */

import { Queue, Worker, type Job } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'

const QUEUE_NAME = 'rica-message-buffer'
const BUFFER_KEY_PREFIX = 'rica:buf:'
const BUFFER_TTL_SECONDS = 120

type BufferJobData = { phone: string }

export type BufferedMessage = {
  phone: string
  combinedText: string
  messageCount: number
}

type MessageHandler = (msg: BufferedMessage) => Promise<void>

// Parseia REDIS_URL em opções para BullMQ
function getRedisOpts() {
  const url = new URL(env.REDIS_URL)
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
    maxRetriesPerRequest: null as null, // obrigatório para BullMQ
  }
}

export class MessageBuffer {
  private readonly redis: IORedis
  private readonly queue: Queue
  private worker: Worker | null = null

  constructor() {
    // IORedis próprio para operações diretas (RPUSH, LRANGE, DEL)
    this.redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })

    // BullMQ recebe opções simples (não instância) — evita conflito de versões
    this.queue = new Queue(QUEUE_NAME, {
      connection: getRedisOpts(),
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 100 },
    })
  }

  async push(phone: string, text: string): Promise<void> {
    const bufferKey = `${BUFFER_KEY_PREFIX}${phone}`

    await this.redis.rpush(bufferKey, text)
    await this.redis.expire(bufferKey, BUFFER_TTL_SECONDS)

    // Upsert: remove job anterior e adiciona novo com delay resetado
    await this.queue.remove(`phone:${phone}`).catch(() => null)
    await this.queue.add('process', { phone }, {
      jobId: `phone:${phone}`,
      delay: env.MSG_BUFFER_WAIT_MS,
    })

    logger.debug({ phone: phone.slice(-4) }, 'Mensagem adicionada ao buffer')
  }

  startWorker(handler: MessageHandler): Worker {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        const { phone } = job.data as BufferJobData
        const bufferKey = `${BUFFER_KEY_PREFIX}${phone}`

        const messages = await this.redis.lrange(bufferKey, 0, -1)
        await this.redis.del(bufferKey)

        if (messages.length === 0) {
          logger.debug({ phone: phone.slice(-4) }, 'Buffer vazio — skip')
          return
        }

        const combinedText = messages.join('\n')
        logger.info({ phone: phone.slice(-4), messageCount: messages.length }, 'Buffer processado')

        await handler({ phone, combinedText, messageCount: messages.length })
      },
      { connection: getRedisOpts(), concurrency: 20 },
    )

    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err }, 'Buffer worker: job falhou')
    })

    return this.worker
  }

  async close(): Promise<void> {
    await this.worker?.close()
    await this.queue.close()
    await this.redis.quit()
  }
}

let _buffer: MessageBuffer | null = null

export function getMessageBuffer(): MessageBuffer {
  if (!_buffer) _buffer = new MessageBuffer()
  return _buffer
}
