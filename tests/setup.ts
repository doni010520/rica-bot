/**
 * tests/setup.ts
 *
 * Configuração global para todos os testes.
 * Roda ANTES de cada arquivo de teste via vitest setupFiles.
 *
 * Garante que process.env tem os mínimos necessários para os módulos
 * que validam env na importação (especialmente src/lib/env.ts).
 *
 * Todos os valores aqui são FAKE — apenas para satisfazer a validação Zod.
 * Não use estes valores em produção.
 */

// ─── env vars de teste ───────────────────────────────────────────────────────

process.env['NODE_ENV'] = 'test'
process.env['PORT'] = '3001'
process.env['LOG_LEVEL'] = 'error' // silencia logs durante testes

process.env['OPENAI_API_KEY'] = 'sk-test-key-fake-for-unit-tests'
process.env['OPENAI_MODEL'] = 'gpt-4.1-mini'
process.env['OPENAI_EMBEDDING_MODEL'] = 'text-embedding-3-small'
process.env['OPENAI_WHISPER_MODEL'] = 'whisper-1'
process.env['OPENAI_VISION_MODEL'] = 'gpt-4o'

process.env['UAZAPI_BASE_URL'] = 'https://test.uazapi.example.com'
process.env['UAZAPI_TOKEN'] = 'test-token'

process.env['SUPABASE_URL'] = 'https://test.supabase.co'
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'test-service-role-key'
process.env['DATABASE_URL'] = 'postgresql://postgres:test@localhost:5432/test'

process.env['REDIS_URL'] = 'redis://localhost:6379'

process.env['CRM_API_URL'] = 'https://test-crm.example.com'
process.env['ORG_ID'] = '00000000-0000-0000-0000-000000000001'

process.env['GESTORA_PHONE'] = '5500000000001'
process.env['VANESSA_PHONE'] = '5500000000002'

process.env['CHAT_MEMORY_TABLE'] = 'n8n_chat_histories'
process.env['LIDIA_TAKEOVER_OFF_COMMAND'] = 'Roberta aqui!'
process.env['LIDIA_TAKEOVER_ON_COMMAND'] = 'tá mais!'
process.env['HR_NOTIFY_PHONE'] = '5500000000003'
process.env['HR_EMAIL'] = 'rh@test.example.com'
process.env['ADMIN_TOKEN'] = ''

// ─── Follow-up executivos (cobrança de status) ──────────────────────────────
process.env['EXEC_FOLLOWUP_ENABLED'] = 'true'
process.env['EXEC_FOLLOWUP_DELAY_HOURS'] = '14'

// ─── Executivos (valores fake mas no formato exigido pelo Zod) ───────────────
// 5510...0001..0010 — claramente sintéticos, não são telefones reais
process.env['EXEC_ANDRE_PHONE']         = '5510000000001'
process.env['EXEC_ANDRE_EMAIL']         = 'andre@test.example.com'
process.env['EXEC_ALEX_PHONE']          = '5510000000002'
process.env['EXEC_ALEX_EMAIL']          = 'alex@test.example.com'
process.env['EXEC_GABRIELA_PHONE']      = '5510000000003'
process.env['EXEC_GABRIELA_EMAIL']      = 'gabriela@test.example.com'
process.env['EXEC_LUCIA_PHONE']         = '5510000000004'
process.env['EXEC_LUCIA_EMAIL']         = 'lucia@test.example.com'
process.env['EXEC_CAROLINA_PHONE']      = '5510000000005'
process.env['EXEC_CAROLINA_EMAIL']      = 'carolina@test.example.com'
process.env['EXEC_HELEN_PHONE']         = '5510000000006'
process.env['EXEC_HELEN_EMAIL']         = 'helen@test.example.com'
process.env['EXEC_MARIA_HELENA_PHONE']  = '5510000000007'
process.env['EXEC_MARIA_HELENA_EMAIL']  = 'maria.helena@test.example.com'
process.env['EXEC_IRELENE_PHONE']       = '5510000000008'
process.env['EXEC_IRELENE_EMAIL']       = 'irelene@test.example.com'
process.env['EXEC_ADONIAS_PHONE']       = '5510000000012'
process.env['EXEC_ADONIAS_EMAIL']       = 'adonias@test.example.com'
process.env['EXEC_ANA_CLARA_PHONE']     = '5510000000009'
process.env['EXEC_ANA_CLARA_EMAIL']     = 'anaclara@test.example.com'
process.env['EXEC_VANESSA_PHONE']       = '5510000000010'
process.env['EXEC_VANESSA_EMAIL']       = 'rh@test.example.com'
