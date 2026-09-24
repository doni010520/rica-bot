/**
 * src/funil/pendencias.ts
 *
 * Pendências de SUPORTE da Jornada da Lucratividade Online (itens em amarelo
 * do "Fluxo Rica - JDL On-line", set/2026):
 *
 *   - aluno sem acesso / não recebeu o e-mail → avisar Jéssica e Hugo e
 *     ACOMPANHAR até a pendência ser resolvida;
 *   - pedido de reembolso → avisar Jéssica e Maria Helena e acompanhar;
 *   - no fim do dia, relatório das ocorrências para a Maria Helena
 *     (entra no resumo diário — ver reports/daily-digest.ts).
 *
 * Acompanhamento: enquanto a pendência estiver aberta, a Rica lembra os
 * responsáveis a cada PENDENCIA_LEMBRETE_HORAS (horário comercial). Para
 * fechar, qualquer responsável responde no WhatsApp da Rica:
 *     resolvido 12        (12 = número da pendência que veio no aviso)
 */

import cron from 'node-cron'
import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { whatsappLink } from '../uazapi/normalize-phone.js'
import { parseContatos } from '../routing/executives.config.js'
import { registrarEvento, digits } from './funil.js'

export type TipoPendencia = 'acesso' | 'reembolso'

function contatosDe(tipo: TipoPendencia) {
  return parseContatos(tipo === 'acesso' ? env.JDL_ACESSO_CONTATOS : env.JDL_REEMBOLSO_CONTATOS)
}

function todosResponsaveis(): Set<string> {
  const chave = (p: string) => `${p.slice(2, 4)}${p.slice(-8)}`
  return new Set(
    [...contatosDe('acesso'), ...contatosDe('reembolso')].map((c) => chave(c.phone)),
  )
}

function ehResponsavel(phone: string): boolean {
  const d = digits(phone)
  return todosResponsaveis().has(`${d.slice(2, 4)}${d.slice(-8)}`)
}

const TITULO: Record<TipoPendencia, string> = {
  acesso: '🔐 *ALUNO SEM ACESSO — Jornada Online*',
  reembolso: '💸 *PEDIDO DE REEMBOLSO — Jornada Online*',
}

export async function criarPendencia(
  pool: Pool,
  p: { phone: string; tipo: TipoPendencia; nome?: string | undefined; email?: string | undefined; descricao?: string | undefined },
): Promise<{ codigo: number; jaExistia: boolean } | null> {
  const log = logger.child({ context: 'pendencias', phone: p.phone.slice(-4) })
  const tel = digits(p.phone)
  try {
    // Mesma pessoa, mesmo tipo, ainda aberta → não duplica (só complementa).
    const aberta = await pool.query<{ codigo: number }>(
      `UPDATE rica_pendencias
         SET email_compra = COALESCE($4, email_compra),
             nome = COALESCE($5, nome),
             descricao = CASE WHEN $6::text IS NULL THEN descricao ELSE concat_ws(' | ', descricao, $6::text) END
       WHERE organization_id = $1 AND phone = $2 AND tipo = $3 AND status = 'aberta'
       RETURNING codigo`,
      [env.ORG_ID, tel, p.tipo, p.email || null, p.nome || null, p.descricao || null],
    )
    if (aberta.rows[0]) return { codigo: aberta.rows[0].codigo, jaExistia: true }

    const r = await pool.query<{ codigo: number }>(
      `INSERT INTO rica_pendencias (organization_id, phone, tipo, nome, email_compra, descricao)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING codigo`,
      [env.ORG_ID, tel, p.tipo, p.nome || null, p.email || null, p.descricao || null],
    )
    const codigo = r.rows[0]?.codigo ?? 0

    const texto =
      `${TITULO[p.tipo]}\n\n` +
      `🆔 Pendência *#${codigo}*\n` +
      `👤 ${p.nome || 'Nome não informado'}\n` +
      `📧 E-mail da compra: ${p.email || 'ainda não informado'}\n` +
      (p.descricao ? `📝 ${p.descricao}\n` : '') +
      `📱 ${whatsappLink(tel)}\n\n` +
      `Quando resolver, me responda aqui: *resolvido ${codigo}*\n` +
      `Até lá eu vou lembrando. 🤖 _Rica_`
    for (const c of contatosDe(p.tipo)) {
      await sendWhatsApp(c.phone, texto, { crmSender: null }).catch((err) => log.warn({ err }, 'aviso de pendência falhou'))
    }
    await registrarEvento(pool, tel, 'jdl', `pendencia_${p.tipo}`, { codigo })
    log.info({ codigo, tipo: p.tipo }, 'Pendência de suporte aberta e avisada')
    return { codigo, jaExistia: false }
  } catch (err) {
    log.error({ err }, 'Falha ao criar pendência')
    return null
  }
}

/**
 * Responsável escreveu "resolvido 12" (ou "#12 resolvido")? Fecha e confirma.
 * Retorna true se a mensagem era esse comando (o webhook para por aqui).
 */
export async function tryResolverPendencia(pool: Pool, phone: string, texto: string): Promise<boolean> {
  if (!ehResponsavel(phone)) return false
  const m = /\bresolvid[oa]\b\D{0,5}#?\s*(\d{1,6})|#?(\d{1,6})\s*resolvid[oa]\b/i.exec(texto ?? '')
  if (!m) return false
  const codigo = Number(m[1] ?? m[2])
  try {
    const r = await pool.query<{ nome: string | null; tipo: string; phone: string }>(
      `UPDATE rica_pendencias SET status = 'resolvida', resolvida_at = NOW(), resolvida_por = $3
       WHERE organization_id = $1 AND codigo = $2 AND status = 'aberta'
       RETURNING nome, tipo, phone`,
      [env.ORG_ID, codigo, digits(phone)],
    )
    const row = r.rows[0]
    const resposta = row
      ? `✅ Pendência #${codigo} (${row.tipo}${row.nome ? ` — ${row.nome}` : ''}) marcada como resolvida. Obrigada!`
      : `Não achei pendência aberta com o número #${codigo}. Confere o número?`
    await sendWhatsApp(phone, resposta, { crmSender: null })
    if (row) await registrarEvento(pool, row.phone, 'jdl', `pendencia_resolvida_${row.tipo}`, { codigo })
    return true
  } catch (err) {
    logger.warn({ err }, 'Falha ao resolver pendência')
    return false
  }
}

/** Lembra os responsáveis das pendências abertas há mais de N horas. */
export async function lembrarPendencias(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'pendencias' })
  try {
    const r = await pool.query<{ codigo: number; tipo: TipoPendencia; nome: string | null; email_compra: string | null; phone: string; horas: number }>(
      `SELECT codigo, tipo, nome, email_compra, phone,
              floor(extract(epoch FROM (NOW() - created_at)) / 3600)::int AS horas
       FROM rica_pendencias
       WHERE organization_id = $1 AND status = 'aberta'
         AND COALESCE(ultimo_lembrete_at, created_at) < NOW() - make_interval(hours => $2)
       ORDER BY created_at`,
      [env.ORG_ID, env.PENDENCIA_LEMBRETE_HORAS],
    )
    for (const p of r.rows) {
      const texto =
        `⏰ *Pendência #${p.codigo} ainda aberta* (${p.tipo}, há ${p.horas}h)\n` +
        `👤 ${p.nome || 'Aluno'} · 📧 ${p.email_compra || 'sem e-mail'}\n` +
        `📱 ${whatsappLink(p.phone)}\n\n` +
        `Resolvido? Me responda: *resolvido ${p.codigo}*`
      for (const c of contatosDe(p.tipo)) {
        await sendWhatsApp(c.phone, texto, { crmSender: null }).catch(() => {})
      }
      await pool.query(
        `UPDATE rica_pendencias SET lembretes = lembretes + 1, ultimo_lembrete_at = NOW()
         WHERE organization_id = $1 AND codigo = $2`,
        [env.ORG_ID, p.codigo],
      )
    }
    if (r.rows.length) log.info({ n: r.rows.length }, 'Lembretes de pendência enviados')
  } catch (err) {
    log.error({ err }, 'Falha nos lembretes de pendência')
  }
}

/** Ocorrências do dia para o resumo da Maria Helena. */
export async function pendenciasDoDia(pool: Pool): Promise<{
  abertasHoje: number
  resolvidasHoje: number
  emAberto: Array<{ codigo: number; tipo: string; nome: string | null; horas: number }>
}> {
  const inicio = `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`
  try {
    const [a, b, c] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM rica_pendencias WHERE organization_id = $1 AND created_at >= ${inicio}`, [env.ORG_ID]),
      pool.query(`SELECT count(*)::int AS n FROM rica_pendencias WHERE organization_id = $1 AND resolvida_at >= ${inicio}`, [env.ORG_ID]),
      pool.query(
        `SELECT codigo, tipo, nome, floor(extract(epoch FROM (NOW() - created_at)) / 3600)::int AS horas
         FROM rica_pendencias WHERE organization_id = $1 AND status = 'aberta' ORDER BY created_at`,
        [env.ORG_ID],
      ),
    ])
    return { abertasHoje: a.rows[0]?.n ?? 0, resolvidasHoje: b.rows[0]?.n ?? 0, emAberto: c.rows }
  } catch {
    return { abertasHoje: 0, resolvidasHoje: 0, emAberto: [] }
  }
}

let _cron: ReturnType<typeof cron.schedule> | null = null

export function startPendenciasWorker(pool: Pool): void {
  if (_cron) return
  _cron = cron.schedule(env.PENDENCIA_CRON, () => void lembrarPendencias(pool), {
    timezone: env.FOLLOWUP_TIMEZONE,
    scheduled: true,
  })
  logger.info({ cron: env.PENDENCIA_CRON }, '🔐 Lembretes de pendência (Jornada) iniciados')
}

export function stopPendenciasWorker(): void {
  _cron?.stop()
  _cron = null
}
