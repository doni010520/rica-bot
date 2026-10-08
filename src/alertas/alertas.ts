/**
 * src/alertas/alertas.ts
 *
 * Alertas de "divergência" da Rica no WhatsApp de quem monitora (Jéssica, a
 * pedido dela em 08/10/2026: "tem como eu ser acionada caso aconteça alguma
 * divergência na Rica?"). Em 07/10 o tráfego da Masterclass caiu na Rica e o time
 * só soube porque os leads estranhos chegaram para a Maria.
 *
 * Três alertas:
 *   1. avalanche — 2+ contatos novos em 2h com a MESMA primeira mensagem que não
 *      é de campanha conhecida (pegaria a Masterclass no 2º contato).
 *   2. barrado   — a porta do lead impediu um "lead quentinho" (motivo junto).
 *   3. falha     — a Rica não conseguiu responder (texto vazio / erro → fallback).
 *
 * Destino: env ALERTAS_PHONES (padrão: Jéssica). Cada alerta tem trava no Redis
 * para não repetir. Nunca lança: alerta que falha não pode derrubar atendimento.
 */

import IORedis from 'ioredis'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { detectarCampanhaDoAnuncio } from '../funil/funil.js'

const JANELA_AVALANCHE_S = 2 * 3600
const MINIMO_AVALANCHE = 2

let _redis: IORedis | null = null
function redis(): IORedis {
  if (!_redis) {
    _redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 })
    _redis.on('error', (err) => logger.warn({ err }, 'Alertas: erro no Redis'))
  }
  return _redis
}

function destinos(): string[] {
  return env.ALERTAS_PHONES.split(',').map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 12)
}

const final4 = (phone: string) => phone.replace(/\D/g, '').slice(-4)

/** Envia o alerta uma vez por `chave` dentro de `ttlS` segundos. */
async function alertar(chave: string, ttlS: number, texto: string): Promise<void> {
  try {
    const primeiro = await redis().set(`alerta:${chave}`, '1', 'EX', ttlS, 'NX')
    if (primeiro !== 'OK') return
    for (const phone of destinos()) {
      await sendWhatsApp(phone, texto, { crmSender: null })
    }
    logger.info({ chave }, '🚨 Alerta enviado')
  } catch (err) {
    logger.warn({ err, chave }, 'Alerta não enviado')
  }
}

/** Primeira mensagem que vale vigiar: tira campanhas conhecidas, cumprimentos e mensagens técnicas. */
export function textoParaVigiar(texto: string): string | null {
  const t = texto.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120)
  if (t.length < 15) return null
  if (t.startsWith('[mensagem de tipo') || t.startsWith('[undecryptable]')) return null
  if (detectarCampanhaDoAnuncio(texto)) return null
  return t
}

/**
 * 1. Avalanche: chamada com a 1ª mensagem de cada contato NOVO. Conta telefones
 *    distintos com o mesmo texto na janela de 2h.
 */
export async function vigiarPrimeiraMensagem(phone: string, texto: string): Promise<void> {
  const t = textoParaVigiar(texto)
  if (!t) return
  try {
    const chave = `avalanche:${Buffer.from(t).toString('base64url').slice(0, 80)}`
    const agora = Date.now()
    const r = redis()
    await r.zadd(chave, agora, phone)
    await r.zremrangebyscore(chave, 0, agora - JANELA_AVALANCHE_S * 1000)
    await r.expire(chave, JANELA_AVALANCHE_S)
    const contatos = await r.zrange(chave, 0, -1)
    if (contatos.length < MINIMO_AVALANCHE) return
    await alertar(
      `${chave}:avisado`,
      6 * 3600,
      `🚨 *Rica — mensagem fora do comum*\n\n` +
        `${contatos.length} contatos novos nas últimas 2h chegaram com a mesma mensagem, que não é de nenhuma campanha conhecida:\n\n` +
        `_"${texto.trim().slice(0, 300)}"_\n\n` +
        `Contatos: ${contatos.map((c) => `…${final4(c)}`).join(', ')}\n\n` +
        `Pode ser anúncio ou link apontando para o número da Rica por engano. Vale conferir com o tráfego.`,
    )
  } catch (err) {
    logger.warn({ err }, 'Vigia de avalanche falhou')
  }
}

/** 2. A porta do lead barrou um encaminhamento. */
export async function alertarBarrado(phone: string, motivo: string): Promise<void> {
  await alertar(
    `barrado:${phone}`,
    24 * 3600,
    `⛔ *Rica — contato não encaminhado*\n\n` +
      `A Rica ia passar o contato https://wa.me/${phone.replace(/\D/g, '')} para a equipe, mas a checagem barrou:\n` +
      `_${motivo}_\n\n` +
      `Se for um lead de verdade, é só encaminhar pelo copiloto.`,
  )
}

/** 3. A Rica não conseguiu responder e mandou a mensagem de fallback. */
export async function alertarFalha(phone: string, detalhe: string): Promise<void> {
  await alertar(
    `falha:${phone}`,
    3600,
    `⚠️ *Rica — falha no atendimento*\n\n` +
      `A Rica não conseguiu responder o contato https://wa.me/${phone.replace(/\D/g, '')} (${detalhe}) e mandou a mensagem padrão de "pode repetir?". Vale olhar a conversa.`,
  )
}
