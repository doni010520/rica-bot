/**
 * src/lidia/status.ts
 *
 * Sistema Lidia ON/OFF — controla se a Rica responde para um telefone específico.
 *
 * CONTEXTO (investigado em 26/mai/2026):
 * - Tabela: "LeadsAlexy" (Supabase, aspas duplas obrigatórias — L e A maiúsculos)
 * - Coluna: `lidia` (text, default 'ON', valores 'ON' | 'OFF')
 * - 803 leads atuais, todos com lidia='ON' (sistema raramente usado pra desligar)
 * - A tabela é SEPARADA do CRM (contacts/deals) — coexiste com ela
 *
 * FLUXO NO N8N (replicado aqui):
 * 1. Mensagem chega (fromMe=false) → Check_lead busca por telefone
 * 2. Se não existe → cria linha com lidia='ON'
 * 3. If7: se lidia='ON' → processa; se lidia='OFF' → skip silencioso
 * 4. Mensagens fromMe=true → detecta comando de takeover → atualiza lidia
 *
 * TAKEOVER (operador humano assume o atendimento):
 * - Operador digita "Roberta aqui!" → lidia='OFF' → Rica para de responder
 * - Operador digita "tá mais!" → lidia='ON' → Rica volta a responder
 *
 * ATENÇÃO: confirmar encoding exato do "tá mais!" com Adonias.
 * No n8n aparece como "t? mais!" (encoding corrompido no dump). Regex cobre ambos.
 */

import type { Pool } from 'pg'
import { logger } from '../observability/logger.js'

// ─── tipos ──────────────────────────────────────────────────────────────────

export type LidiaStatus = 'ON' | 'OFF'

export type LidiaCheckResult =
  | { exists: true; lidia: LidiaStatus }
  | { exists: false; lidia: null }

// ─── comandos de takeover ────────────────────────────────────────────────────
// Regex cobre variações de encoding e pontuação
const TAKEOVER_OFF_PATTERN = /roberta aqui[!.]?/i
const TAKEOVER_ON_PATTERN = /t[aá] mais[!.]?/i

// ─── funções principais ──────────────────────────────────────────────────────

/**
 * Verifica se a Rica está habilitada para um telefone.
 * Replica o comportamento de Check_lead (Supabase) + If7 do n8n.
 *
 * @returns { exists: false } se lead não existe (Rica deve processar + criar)
 * @returns { exists: true, lidia: 'ON' } se deve processar
 * @returns { exists: true, lidia: 'OFF' } se deve skipar silenciosamente
 */
export async function checkLidiaStatus(pool: Pool, phone: string): Promise<LidiaCheckResult> {
  try {
    // Nota: n8n usa LIKE (não =). Mantemos = com normalização prévia do telefone.
    const result = await pool.query<{ lidia: string | null }>(
      `SELECT lidia FROM "LeadsAlexy" WHERE telefone = $1 LIMIT 1`,
      [phone],
    )

    if (result.rows.length === 0) {
      return { exists: false, lidia: null }
    }

    // Default 'ON' quando coluna é NULL (mesma lógica do n8n)
    const lidia = (result.rows[0]?.lidia ?? 'ON') as LidiaStatus
    return { exists: true, lidia }
  } catch (err) {
    // Fail-open: se não conseguir consultar, deixa Rica responder
    // (melhor responder erroneamente do que ficar mudo pra sempre)
    logger.error({ err, phone, fn: 'checkLidiaStatus' }, 'Erro ao consultar lidia — fail-open')
    return { exists: true, lidia: 'ON' }
  }
}

/**
 * Cria entrada na tabela LeadsAlexy para lead novo.
 * Replica o comportamento do nó "Create a row" do n8n.
 *
 * ON CONFLICT DO NOTHING: seguro para chamar múltiplas vezes (idempotente).
 */
export async function createLeadEntry(
  pool: Pool,
  data: { phone: string; name?: string },
): Promise<void> {
  try {
    // ON CONFLICT (telefone) NÃO funciona aqui: a tabela só tem índice único em
    // `id`, então o Postgres recusa com "no unique or exclusion constraint
    // matching". Como o catch abaixo trata a falha como não-crítica, o INSERT
    // vinha falhando em SILÊNCIO e nenhuma linha era criada — o que quebrava o
    // takeover (setLidiaStatus é UPDATE: sem linha, não desliga nada).
    //
    // Criar o índice único resolveria, mas hoje há 40 telefones duplicados na
    // tabela (811 linhas / 771 distintos), então a criação falharia. WHERE NOT
    // EXISTS dá o mesmo efeito sem depender de constraint nem mexer no schema.
    await pool.query(
      `INSERT INTO "LeadsAlexy" (nome, telefone, status, "Follow-up", lidia)
       SELECT $1, $2, 'novo_lead', 'nao_enviado', 'ON'
        WHERE NOT EXISTS (SELECT 1 FROM "LeadsAlexy" WHERE telefone = $2)`,
      [data.name ?? null, data.phone],
    )
    logger.info({ phone: data.phone }, 'Lead criado em LeadsAlexy')
  } catch (err) {
    // Não é crítico — loga e segue (CRM é a fonte de verdade real)
    logger.warn({ err, phone: data.phone, fn: 'createLeadEntry' }, 'Falha ao criar lead em LeadsAlexy')
  }
}

/**
 * Atualiza o status lidia para um telefone.
 * Chamado pelo detector de takeover quando operador usa comando.
 */
export async function setLidiaStatus(
  pool: Pool,
  phone: string,
  status: LidiaStatus,
): Promise<void> {
  try {
    await pool.query(`UPDATE "LeadsAlexy" SET lidia = $1 WHERE telefone = $2`, [status, phone])
    logger.info({ phone, status }, 'lidia_toggled')
  } catch (err) {
    logger.error({ err, phone, status, fn: 'setLidiaStatus' }, 'Erro ao atualizar lidia')
    throw err
  }
}

// ─── detector de takeover ─────────────────────────────────────────────────────

/**
 * Detecta se uma mensagem fromMe=true é um comando de takeover.
 *
 * Chamado APENAS quando fromMe=true (operador humano no WhatsApp da Sucesso).
 * Se detectar comando, retorna o novo status. Se não, retorna null.
 *
 * @example
 * detectTakeoverCommand("Roberta aqui! Tudo bem?") // → 'OFF'
 * detectTakeoverCommand("tá mais!")                // → 'ON'
 * detectTakeoverCommand("Obrigada!")               // → null
 */
export function detectTakeoverCommand(message: string): LidiaStatus | null {
  if (TAKEOVER_OFF_PATTERN.test(message)) return 'OFF'
  if (TAKEOVER_ON_PATTERN.test(message)) return 'ON'
  return null
}
