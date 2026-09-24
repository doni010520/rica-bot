/**
 * src/funil/resgate.ts
 *
 * RESGATE de leads antigos da Jornada da Lucratividade Online
 * ("Cadência de vendas da Rica", seção 5, set/2026).
 *
 * Elegível: lead da Jornada sem compra, sem pedido de parada, sem executivo
 * negociando e parado há 3+ dias. Uma sequência por lead (rica_resgate guarda
 * quem já entrou), em LOTES diários pequenos (RESGATE_LOTE_DIARIO):
 *   contato 1 no dia 0 · contato 2 três dias depois · contato 3 cinco dias depois.
 * Qualquer resposta do lead encerra a sequência (funil.aoReceberDoLead) e a
 * Rica continua a conversa do ponto indicado pela resposta.
 *
 * DESLIGADO por padrão (RESGATE_ENABLED=false): é disparo para quem parou de
 * responder, e pela API não oficial do WhatsApp isso aumenta o risco de
 * bloqueio do número. Ligar só com lotes pequenos e acompanhando.
 */

import cron from 'node-cron'
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { isTeamPhone } from '../routing/executives.config.js'
import { registrarEvento } from './funil.js'

const [INTERVALO_2, INTERVALO_3] = env.RESGATE_INTERVALO_DIAS.split(',').map((n) => Number(n.trim()) || 3) as [number, number]

function primeiroNome(nome: string | null): string {
  const n = (nome ?? '').trim()
  if (!n || /^\+?\d[\d\s-]+$/.test(n)) return ''
  return n.split(/\s+/)[0] ?? ''
}

export function mensagemResgate(passo: 1 | 2 | 3, nome: string | null, dor: string | null): string {
  const oi = primeiroNome(nome) ? `Oi, ${primeiroNome(nome)}!` : 'Oi!'
  if (passo === 1) {
    const hipotese = dor
      ? `Na época, você me contou que ${dor.replace(/[.!]+$/, '')}.`
      : 'Talvez melhorar a lucratividade da sua padaria ainda esteja nos seus planos.'
    return `${oi} Sou a Rica, da Sucesso na Padaria. Faz um tempo que você me chamou para saber da Jornada da Lucratividade Online, mas nossa conversa não continuou. ${hipotese} Vamos retomar essa jornada? Quer que eu te envie o link para conhecer as aulas e começar?`
  }
  if (passo === 2) {
    return `${oi} Passando para retomar nosso papo sobre a Jornada. Às vezes a correria da padaria faz a gente adiar justamente o tempo de olhar para o lucro. Se você pudesse melhorar um ponto agora, escolheria margem, desperdício ou gestão? Me conta e eu te mostro por onde começar nas aulas.`
  }
  return `${oi} Sou a Rica, da Sucesso na Padaria. Vou encerrar minhas mensagens sobre a Jornada para respeitar seu tempo. Se quiser voltar a cuidar da lucratividade da sua padaria, é só me escrever "Jornada" que eu te envio o programa e o link para começar. Estarei por aqui!`
}

/** Grava a mensagem na memória da conversa: quando o lead responder, a Rica sabe do que se trata. */
async function lembrarNaConversa(pool: Pool, phone: string, texto: string): Promise<void> {
  await pool.query(
    `INSERT INTO "${env.CHAT_MEMORY_TABLE}" (session_id, message) VALUES ($1, $2)`,
    [phone, JSON.stringify({ type: 'ai', data: { content: texto, additional_kwargs: {} } })],
  ).catch(() => {})
}

async function enviar(pool: Pool, row: { phone: string; nome: string | null; dor: string | null; deal_id: string | null }, passo: 1 | 2 | 3) {
  const texto = mensagemResgate(passo, row.nome, row.dor)
  await sendWhatsApp(row.phone, texto, { crmSender: 'system_followup', dealId: row.deal_id ?? undefined })
  await lembrarNaConversa(pool, row.phone, texto)
  await pool.query(
    `UPDATE rica_resgate SET passo = $3, ultimo_envio_at = NOW(), encerrado = $4
     WHERE organization_id = $1 AND phone = $2 AND campanha = 'jdl'`,
    [env.ORG_ID, row.phone, passo, passo === 3],
  )
  await registrarEvento(pool, row.phone, 'jdl', `resgate_contato_${passo}`)
}

export async function rodarResgate(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'resgate-jdl' })
  try {
    // 1. Próximos contatos de quem já está na sequência e não respondeu.
    const devidos = await pool.query<{ phone: string; passo: number; nome: string | null; dor: string | null; deal_id: string | null }>(
      `SELECT r.phone, r.passo, r.nome, f.dor_principal AS dor, f.deal_id
       FROM rica_resgate r
       LEFT JOIN rica_lead_funil f ON f.organization_id = r.organization_id AND f.phone = r.phone AND f.campanha = 'jdl'
       WHERE r.organization_id = $1 AND r.campanha = 'jdl' AND NOT r.encerrado AND r.respondeu_at IS NULL
         AND COALESCE(f.nao_contatar, false) = false
         AND ((r.passo = 1 AND r.ultimo_envio_at <= NOW() - make_interval(days => $2))
           OR (r.passo = 2 AND r.ultimo_envio_at <= NOW() - make_interval(days => $3)))`,
      [env.ORG_ID, INTERVALO_2, INTERVALO_3],
    )
    for (const d of devidos.rows) {
      await enviar(pool, d, (d.passo + 1) as 2 | 3)
    }

    // 2. Novo lote: leads da Jornada parados, sem compra e fora de negociação.
    const lote = await pool.query<{ phone: string; nome: string | null; dor: string | null; deal_id: string | null }>(
      `SELECT DISTINCT ON (tel) tel AS phone, nome, dor, deal_id FROM (
         SELECT regexp_replace(d.contact_phone, '\\D', '', 'g') AS tel, d.contact_name AS nome,
                f.dor_principal AS dor, d.id AS deal_id, d.updated_at
         FROM deals d
         JOIN pipelines p ON p.id = d.pipeline_id
         LEFT JOIN rica_lead_funil f ON f.organization_id = d.organization_id
              AND f.phone = regexp_replace(d.contact_phone, '\\D', '', 'g') AND f.campanha = 'jdl'
         WHERE d.organization_id = $1
           AND p.name ILIKE '%jornada%'
           AND d.status <> 'won'
           AND NOT (d.status = 'open' AND d.owner_id IS NOT NULL)
           AND d.updated_at < NOW() - INTERVAL '3 days'
           AND f.compra_confirmada_at IS NULL
           AND COALESCE(f.nao_contatar, false) = false
       ) x
       WHERE length(tel) >= 12
         AND NOT EXISTS (SELECT 1 FROM rica_resgate r WHERE r.organization_id = $1 AND r.phone = x.tel)
         AND NOT EXISTS (SELECT 1 FROM rica_lead_funil n WHERE n.organization_id = $1 AND n.phone = x.tel AND n.nao_contatar)
       ORDER BY tel, updated_at DESC
       LIMIT $2`,
      [env.ORG_ID, env.RESGATE_LOTE_DIARIO],
    )
    let novos = 0
    for (const l of lote.rows) {
      if (isTeamPhone(l.phone)) continue
      await pool.query(
        `INSERT INTO rica_resgate (organization_id, phone, campanha, nome) VALUES ($1, $2, 'jdl', $3)
         ON CONFLICT DO NOTHING`,
        [env.ORG_ID, l.phone, l.nome],
      )
      await enviar(pool, l, 1)
      novos++
    }
    log.info({ continuacoes: devidos.rows.length, novos }, '📣 Resgate da Jornada executado')
  } catch (err) {
    log.error({ err }, 'Falha no resgate da Jornada')
  }
}

let _cron: ReturnType<typeof cron.schedule> | null = null

export function startResgateWorker(pool: Pool): void {
  if (_cron) return
  if (!env.RESGATE_ENABLED) {
    logger.info('Resgate da Jornada DESLIGADO (RESGATE_ENABLED=false)')
    return
  }
  _cron = cron.schedule(env.RESGATE_CRON, () => void rodarResgate(pool), {
    timezone: env.FOLLOWUP_TIMEZONE,
    scheduled: true,
  })
  logger.info({ cron: env.RESGATE_CRON, lote: env.RESGATE_LOTE_DIARIO }, '📣 Resgate da Jornada iniciado')
}

export function stopResgateWorker(): void {
  _cron?.stop()
  _cron = null
}
