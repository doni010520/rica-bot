/**
 * src/memory/postgres-chat.ts
 *
 * Memória de conversa em Postgres — equivalente do "Postgres Chat Memory1" do n8n.
 *
 * O n8n usa LangChain PostgresChatMessageHistory com:
 *   - sessionKey = telefone (ex: "5511999887766")
 *   - contextWindowLength = padrão (~10 pares = 20 mensagens)
 *
 * A tabela criada pelo LangChain (e confirmada no Supabase em 27/mai/2026) tem:
 *   CREATE TABLE IF NOT EXISTS {tableName} (
 *     id          SERIAL PRIMARY KEY,
 *     session_id  VARCHAR NOT NULL,
 *     message     JSONB   NOT NULL
 *   )
 * Não tem `created_at` — a ordenação é via `id` (serial monotônico).
 *
 * O campo `message` é um JSON com { type: 'human'|'ai', data: { content: string } }
 *
 * NOTA: Esta implementação é compatível com o formato LangChain para que a
 * memória existente do n8n seja reutilizada sem migração de dados.
 * Verificar o nome exato da tabela no Supabase (env: CHAT_MEMORY_TABLE).
 */

import { type Pool } from 'pg'
import { logger } from '../observability/logger.js'
import { env } from '../lib/env.js'

// ─── tipos ────────────────────────────────────────────────────────────────────

export type ChatRole = 'human' | 'ai'

export type ChatMessage = {
  role: ChatRole
  content: string
}

/** Formato compatível com LangChain PostgresChatMessageHistory */
type LangChainMessage = {
  type: ChatRole
  data: { content: string; additional_kwargs?: Record<string, unknown> }
}

// ─── funções públicas ─────────────────────────────────────────────────────────

/**
 * Carrega o histórico de conversa de um telefone.
 * Replica: Postgres Chat Memory do n8n (read on agent start).
 *
 * @param pool - Pool de conexões Postgres
 * @param phone - Telefone normalizado (session_id)
 * @param limit - Número de mensagens a carregar (default: env.CHAT_MEMORY_WINDOW)
 * @returns Array de mensagens ordenadas do mais antigo para o mais recente
 */
export async function loadChatHistory(
  pool: Pool,
  phone: string,
  limit = env.CHAT_MEMORY_WINDOW,
): Promise<ChatMessage[]> {
  const table = env.CHAT_MEMORY_TABLE

  try {
    // Pega as N mensagens mais recentes (ordenadas por id desc), depois inverte
    // para ordem cronológica. A tabela n8n_chat_histories não tem created_at —
    // ordenação por id (SERIAL monotônico) é a única opção.
    const result = await pool.query<{ message: LangChainMessage }>(
      `SELECT message
       FROM "${table}"
       WHERE session_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [phone, limit],
    )

    const messages = result.rows
      .reverse()
      .map((row): ChatMessage => ({
        role: row.message.type,
        content: row.message.data.content,
      }))

    logger.debug({ phone: phone.slice(-4), count: messages.length }, 'Histórico carregado')
    return messages
  } catch (err) {
    // Se tabela não existe ainda, retorna vazio (não crasha)
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg.includes('does not exist') || errMsg.includes('relation')) {
      logger.warn({ table, phone: phone.slice(-4) }, 'Tabela de memória não encontrada — retornando vazio')
      return []
    }
    logger.error({ err, phone: phone.slice(-4) }, 'Erro ao carregar histórico')
    return []
  }
}

/**
 * Salva um par de mensagens (humano + IA) no histórico.
 * Replica: Postgres Chat Memory do n8n (write after agent response).
 *
 * @param pool - Pool de conexões Postgres
 * @param phone - Telefone normalizado (session_id)
 * @param humanText - Mensagem do cliente
 * @param aiText - Resposta da Rica
 */
export async function saveChatTurn(
  pool: Pool,
  phone: string,
  humanText: string,
  aiText: string,
): Promise<void> {
  const table = env.CHAT_MEMORY_TABLE

  const humanMsg: LangChainMessage = {
    type: 'human',
    data: { content: humanText, additional_kwargs: {} },
  }

  const aiMsg: LangChainMessage = {
    type: 'ai',
    data: { content: aiText, additional_kwargs: {} },
  }

  try {
    await pool.query(
      `INSERT INTO "${table}" (session_id, message) VALUES ($1, $2), ($1, $3)`,
      [phone, JSON.stringify(humanMsg), JSON.stringify(aiMsg)],
    )
    logger.debug({ phone: phone.slice(-4) }, 'Turno salvo na memória')
  } catch (err) {
    // Tenta criar a tabela se não existir
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg.includes('does not exist') || errMsg.includes('relation')) {
      await createMemoryTable(pool, table)
      // Retenta uma vez
      await pool
        .query(`INSERT INTO "${table}" (session_id, message) VALUES ($1, $2), ($1, $3)`, [
          phone,
          JSON.stringify(humanMsg),
          JSON.stringify(aiMsg),
        ])
        .catch((e) => logger.error({ e }, 'Erro ao salvar memória após criar tabela'))
    } else {
      logger.error({ err, phone: phone.slice(-4) }, 'Erro ao salvar turno na memória')
    }
  }
}

/**
 * Limpa toda a memória de conversa de um telefone.
 * Replica: Delete table or rows1 do n8n (comando "limpar memória").
 */
export async function clearChatHistory(pool: Pool, phone: string): Promise<void> {
  const table = env.CHAT_MEMORY_TABLE
  try {
    await pool.query(`DELETE FROM "${table}" WHERE session_id = $1`, [phone])
    logger.info({ phone: phone.slice(-4) }, 'Memória de conversa limpa')
  } catch (err) {
    logger.warn({ err, phone: phone.slice(-4) }, 'Erro ao limpar memória')
  }
}

/**
 * Converte histórico de chat para o formato de messages do AI SDK.
 * Útil para passar o contexto diretamente ao generateText().
 */
export function historyToMessages(
  history: ChatMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.map((msg) => ({
    role: msg.role === 'human' ? 'user' : 'assistant',
    content: msg.content,
  }))
}

// ─── setup de tabela ──────────────────────────────────────────────────────────

/**
 * Cria a tabela de memória se não existir.
 * Schema idêntico ao que o n8n PostgresChatMessageHistory cria
 * (confirmado no Supabase em 27/mai/2026).
 */
export async function createMemoryTable(pool: Pool, tableName: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id          SERIAL PRIMARY KEY,
      session_id  VARCHAR NOT NULL,
      message     JSONB   NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "${tableName}_session_idx"
      ON "${tableName}" (session_id, id);
  `)
  logger.info({ tableName }, 'Tabela de memória criada')
}
