/**
 * src/grupos/envios-agendados.ts
 *
 * Mensagens que a Rica dispara em GRUPOS de WhatsApp em data e hora marcadas.
 * Primeiro uso: régua da Masterclass de 14/10/2026 (cards e textos da Malu).
 *
 * Tabela rica_envios_grupo (migration 025 do CRM). A cada minuto o worker pega o
 * que venceu, marca como "enviando" (nunca manda duas vezes) e envia pelo número
 * da Rica, que precisa estar no grupo (e ser admin, se só admins podem enviar).
 *
 * Atraso: se o bot ficou fora do ar e a mensagem venceu há mais de 90 min, ela
 * NÃO sai ("É amanhã!" no dia seguinte confunde mais do que ajuda) e quem
 * monitora recebe alerta.
 */

import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendToGroup } from '../uazapi/client.js'
import { alertarEnvioGrupo } from '../alertas/alertas.js'

const ATRASO_MAX_MIN = 90
let _timer: NodeJS.Timeout | null = null

type Envio = { id: number; grupo_jid: string; enviar_em: Date; texto: string; midia_url: string | null; descricao: string | null }

export async function processarEnviosVencidos(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'envios-grupo' })
  const { rows } = await pool.query<Envio>(
    `UPDATE rica_envios_grupo SET status = 'enviando'
      WHERE id IN (SELECT id FROM rica_envios_grupo
                    WHERE organization_id = $1 AND status = 'pendente' AND enviar_em <= now()
                    ORDER BY enviar_em LIMIT 10 FOR UPDATE SKIP LOCKED)
      RETURNING id, grupo_jid, enviar_em, texto, midia_url, descricao`,
    [env.ORG_ID],
  )
  for (const e of rows) {
    const atrasoMin = (Date.now() - new Date(e.enviar_em).getTime()) / 60_000
    if (atrasoMin > ATRASO_MAX_MIN) {
      await pool.query(`UPDATE rica_envios_grupo SET status = 'atrasado', erro = $2 WHERE id = $1`, [e.id, `vencido há ${Math.round(atrasoMin)} min`])
      void alertarEnvioGrupo(e.id, `não saiu: venceu há ${Math.round(atrasoMin)} min (${e.descricao ?? 'sem descrição'})`)
      log.warn({ id: e.id, atrasoMin }, 'Envio em grupo vencido demais — não enviado')
      continue
    }
    try {
      await sendToGroup(e.grupo_jid, { texto: e.texto, midiaUrl: e.midia_url })
      await pool.query(`UPDATE rica_envios_grupo SET status = 'enviado', enviado_at = now(), erro = NULL WHERE id = $1`, [e.id])
      log.info({ id: e.id, grupo: e.grupo_jid, descricao: e.descricao }, '📣 Envio em grupo feito')
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 500)
      await pool.query(`UPDATE rica_envios_grupo SET status = 'erro', erro = $2 WHERE id = $1`, [e.id, msg])
      void alertarEnvioGrupo(e.id, `falhou (${e.descricao ?? 'sem descrição'}): ${msg.slice(0, 150)}`)
      log.error({ err, id: e.id }, 'Envio em grupo falhou')
    }
  }
}

/** Liga o worker (a cada minuto). Chamado no boot. */
export function startEnviosGrupoWorker(pool: Pool): void {
  if (_timer) return
  const rodar = () => processarEnviosVencidos(pool).catch((err) => logger.error({ err }, 'Worker de envios em grupo falhou'))
  _timer = setInterval(() => { void rodar() }, 60_000)
  void rodar()
  logger.info('📣 Worker de envios agendados em grupo iniciado')
}

export function stopEnviosGrupoWorker(): void {
  if (_timer) clearInterval(_timer)
  _timer = null
}
