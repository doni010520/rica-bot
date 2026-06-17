/**
 * src/lib/env.ts
 * Validação centralizada de variáveis de ambiente via Zod.
 * Processo FALHA NA INICIALIZAÇÃO se alguma var obrigatória estiver ausente.
 */

import { z } from 'zod'

const intStr = (def: number) =>
  z.string().optional().default(String(def)).pipe(z.coerce.number().int().positive())

const EnvSchema = z.object({
  // ── Geral ──────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: intStr(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY é obrigatória'),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_WHISPER_MODEL: z.string().default('whisper-1'),
  OPENAI_VISION_MODEL: z.string().default('gpt-4o'),
  OPENAI_TEMPERATURE: z.string().optional().default('0.5').pipe(z.coerce.number().min(0).max(2)),

  // ── uazapi ─────────────────────────────────────────────────────────────────
  UAZAPI_BASE_URL: z.string().url(),
  UAZAPI_TOKEN: z.string().min(1),
  UAZAPI_WEBHOOK_PATH: z.string().default('/webhook/uazapi'),

  // ── Supabase / Postgres ────────────────────────────────────────────────────
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SUPABASE_VECTOR_TABLE: z.string().default('documents'),

  // ── Redis ──────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().min(1),

  // ── CRM API ────────────────────────────────────────────────────────────────
  CRM_API_URL: z.string().url(),
  ORG_ID: z.string().uuid(),

  // ── Follow-up (leads) ───────────────────────────────────────────────────────
  FOLLOWUP_CRON: z.string().default('0 9-18 * * 1-5'),
  FOLLOWUP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  FOLLOWUP_MAX_ATTEMPTS: intStr(3),
  FOLLOWUP_CLOSE_AFTER_DAYS: intStr(7),

  // ── Follow-up (executivos — cobrança de status) ────────────────────────────
  // Após encaminhar lead, Rica cobra o executivo N horas depois.
  EXEC_FOLLOWUP_ENABLED: z.string().optional().default('true').transform((v) => v !== 'false'),
  EXEC_FOLLOWUP_DELAY_HOURS: intStr(24),

  // ── Resumo diário (digest para a gestora — Maria Helena) ────────────────────
  DAILY_DIGEST_ENABLED: z.string().optional().default('true').transform((v) => v !== 'false'),
  DAILY_DIGEST_CRON: z.string().default('0 20 * * *'),

  // ── Análise semanal de gargalos (LLM) para a gestora ────────────────────────
  INSIGHTS_ENABLED: z.string().optional().default('true').transform((v) => v !== 'false'),
  INSIGHTS_CRON: z.string().default('0 8 * * 1'),

  // ── Dedup ──────────────────────────────────────────────────────────────────
  DEDUP_TTL_SECONDS: intStr(3600),

  // ── Buffer de mensagens ───────────────────────────────────────────────────
  MSG_BUFFER_WAIT_MS: intStr(10000),

  // ── Chunking de resposta ──────────────────────────────────────────────────
  CHUNK_DELAY_MS: intStr(2500),

  // ── Contatos fixos ────────────────────────────────────────────────────────
  GESTORA_PHONE: z.string().min(1),
  VANESSA_PHONE: z.string().min(1),

  // ── Lidia ON/OFF ──────────────────────────────────────────────────────────
  LIDIA_STATUS_TABLE: z.string().default('LeadsAlexy'),
  LIDIA_STATUS_COLUMN: z.string().default('lidia'),
  LIDIA_TAKEOVER_OFF_COMMAND: z.string().default('Roberta aqui!'),
  LIDIA_TAKEOVER_ON_COMMAND: z.string().default('tá mais!'),

  // ── Memória de chat ───────────────────────────────────────────────────────
  // Nome da tabela criada pelo Postgres Chat Memory do n8n (verificar no Supabase)
  // Tabela criada automaticamente pelo n8n Postgres Chat Memory: n8n_chat_histories
  // Schema: id SERIAL, session_id TEXT, message JSONB, created_at TIMESTAMPTZ
  CHAT_MEMORY_TABLE: z.string().default('n8n_chat_histories'),
  // Janela de contexto: quantas mensagens carregar (n8n usa default ~10 pares)
  CHAT_MEMORY_WINDOW: intStr(20),

  // ── Candidatos / RH ──────────────────────────────────────────────────────────
  // Telefone da Vanessa (RH) — sem defaults pra não vazar PII no repo
  HR_NOTIFY_PHONE: z.string().min(1),
  HR_EMAIL: z.string().email(),

  // ── Observabilidade ───────────────────────────────────────────────────────
  ALERT_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),

  // ── Allowlist (modo de teste isolado) ────────────────────────────────────
  // Lista de telefones separados por vírgula (com DDI 55, ex: "5511999...,5581988...")
  // Se vazia, processa TODOS os webhooks (modo produção).
  // Se preenchida, ignora silenciosamente mensagens fora da lista.
  ALLOWED_PHONES: z.string().optional().default(''),

  // ── Admin endpoint (/admin/logs) ─────────────────────────────────────────
  // Token simples pra proteger leitura de logs in-memory via HTTP.
  // Se vazio, endpoint aberto (desenvolvimento). Em prod, sempre setar.
  ADMIN_TOKEN: z.string().optional().default(''),

  // ── Executivos (fonte de verdade — telefones e emails fora do repo) ──────
  // Telefones com DDI 55 (ex: 5511958430345). Validados no boot.
  EXEC_ANDRE_PHONE:        z.string().regex(/^55\d{10,11}$/, 'EXEC_ANDRE_PHONE: dígitos com DDI 55'),
  EXEC_ANDRE_EMAIL:        z.string().email(),
  EXEC_ALEX_PHONE:         z.string().regex(/^55\d{10,11}$/),
  EXEC_ALEX_EMAIL:         z.string().email(),
  EXEC_GABRIELA_PHONE:     z.string().regex(/^55\d{10,11}$/),
  EXEC_GABRIELA_EMAIL:     z.string().email(),
  EXEC_LUCIA_PHONE:        z.string().regex(/^55\d{10,11}$/),
  EXEC_LUCIA_EMAIL:        z.string().email(),
  EXEC_CAROLINA_PHONE:     z.string().regex(/^55\d{10,11}$/),
  EXEC_CAROLINA_EMAIL:     z.string().email(),
  EXEC_HELEN_PHONE:        z.string().regex(/^55\d{10,11}$/),
  EXEC_HELEN_EMAIL:        z.string().email(),
  EXEC_MARIA_HELENA_PHONE: z.string().regex(/^55\d{10,11}$/),
  EXEC_MARIA_HELENA_EMAIL: z.string().email(),
  EXEC_IRELENE_PHONE:      z.string().regex(/^55\d{10,11}$/),
  EXEC_IRELENE_EMAIL:      z.string().email(),
  EXEC_ANA_CLARA_PHONE:    z.string().regex(/^55\d{10,11}$/),
  EXEC_ANA_CLARA_EMAIL:    z.string().email(),
  EXEC_VANESSA_PHONE:      z.string().regex(/^55\d{10,11}$/),
  EXEC_VANESSA_EMAIL:      z.string().email(),
})

export type Env = z.infer<typeof EnvSchema>

function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    console.error(`\n❌ Env vars inválidas:\n${errors}\n`)
    process.exit(1)
  }
  return result.data
}

export const env = parseEnv()
// Sprint 2 additions handled by module re-parse — see EnvSchema above
