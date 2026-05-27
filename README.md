# rica-bot

Agente WhatsApp da Rica IA para a **Sucesso no Resultado**.

Migração do workflow n8n (99 nós + 22 subworkflows) para TypeScript com controle total, testes e sem os bugs recorrentes do n8n.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 22 |
| Linguagem | TypeScript (strict) |
| HTTP | Fastify 5 |
| LLM | AI SDK (Vercel) + `@ai-sdk/openai` |
| Validação | Zod (input/output de todas as tools) |
| Fila | BullMQ 5 + Redis |
| Cron | node-cron 3 |
| Logger | pino 9 (JSON em prod, pretty em dev) |
| Testes | Vitest 2 |
| Banco | Postgres (via `pg`) + Supabase |

---

## Setup local

### Pré-requisitos

- Node.js 22+
- Redis (local ou via Docker)
- Postgres / Supabase (apenas para testes de integração)

### Instalação

```bash
# 1. Clonar / entrar no diretório
cd rica-bot

# 2. Instalar dependências
npm install

# 3. Configurar variáveis de ambiente
cp .env.example .env
# Editar .env com os valores reais (ver seção abaixo)

# 4. Rodar em desenvolvimento
npm run dev
```

### Desenvolvimento com Docker

```bash
# Sobe o container em modo dev (sem rebuild a cada mudança)
docker build -t rica-bot .
docker run --env-file .env -p 3000:3000 rica-bot
```

---

## Variáveis de ambiente

Todas as variáveis estão documentadas em `.env.example`. As obrigatórias:

| Variável | Descrição |
|---|---|
| `OPENAI_API_KEY` | Chave da OpenAI (credential "Rica" do n8n) |
| `UAZAPI_BASE_URL` | Base URL do uazapi |
| `UAZAPI_TOKEN` | Token de autenticação uazapi |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key do Supabase |
| `DATABASE_URL` | Connection string Postgres |
| `REDIS_URL` | URL do Redis |
| `CRM_API_URL` | URL base do CRM API |
| `ORG_ID` | UUID da organização (`00000000-0000-0000-0000-000000000001`) |
| `GESTORA_PHONE` | Telefone da gestora Maria Helena |
| `VANESSA_PHONE` | Telefone da Vanessa Souza (RH) |

O processo **falha na inicialização** se qualquer variável obrigatória estiver ausente — fail-fast intencional.

---

## Comandos

```bash
npm run dev          # Desenvolvimento com hot-reload (tsx watch)
npm run build        # Compilar TypeScript → dist/
npm start            # Rodar produção (dist/)
npm run typecheck    # Verificar tipos sem compilar
npm test             # Todos os testes
npm run test:unit    # Somente testes unitários
npm run test:watch   # Testes em modo watch
npm run test:coverage # Cobertura de código
npm run lint         # ESLint
npm run format       # Prettier
```

---

## Endpoints

| Método | Path | Descrição |
|---|---|---|
| GET | `/health` | Liveness probe (sempre 200 se rodando) |
| GET | `/ready` | Readiness probe (checa Redis + Postgres) |
| POST | `/webhook/uazapi` | Webhook principal (mensagens WhatsApp) |

---

## Estrutura de pastas

```
rica-bot/
├── src/
│   ├── index.ts                    # Entrypoint Fastify
│   ├── lib/
│   │   ├── env.ts                  # Validação Zod de env vars
│   │   ├── timezone.ts             # Datas em BRT (America/Sao_Paulo)
│   │   └── retry.ts                # Retry com backoff exponencial
│   ├── observability/
│   │   └── logger.ts               # Logger pino estruturado
│   ├── webhook/                    # Sprint 1 — handler de mensagens
│   ├── agent/                      # Sprint 1 — agent LLM + prompts
│   ├── tools/
│   │   ├── crm/                    # Sprint 2 — 14 CRM tools (Zod)
│   │   ├── operations/             # Sprint 3/5 — tools operacionais
│   │   └── rag/                    # Sprint 5 — buscar_documentos
│   ├── crm/                        # Sprint 2 — pre-fetch, save-message
│   ├── routing/                    # Sprint 3 — roteamento executivos
│   ├── buffer/                     # Sprint 1 — buffer Redis 10s
│   ├── dedup/                      # Sprint 3 — Redis INCR dedup
│   ├── media/                      # Sprint 1 — áudio/imagem/PDF
│   ├── uazapi/                     # Sprint 1 — cliente + normalize
│   ├── lidia/                      # Sprint 1 — ON/OFF status
│   ├── candidato/                  # Sprint 2 — detect + notify Vanessa
│   ├── memory/                     # Sprint 1 — Postgres Chat Memory
│   └── followup/                   # Sprint 4 — worker cron
├── tests/
│   ├── unit/                       # Testes unitários (sem I/O)
│   ├── integration/                # Testes com HTTP/DB
│   └── e2e/                        # Testes end-to-end
├── prompts/                        # System prompts (.md versionados)
├── migrations/                     # Migrations adicionais (se precisar)
├── .env.example
├── Dockerfile
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Plano de sprints

| Sprint | Conteúdo | Status |
|---|---|---|
| **-1** | Mapeamento profundo (Lidia ON/OFF, IF_Candidato, RAG, etc.) | A fazer |
| **0** | Setup projeto, health endpoints, CI | ✅ **Concluído** |
| **1** | Webhook + Agent core (texto, áudio, imagem, PDF, buffer) | A fazer |
| **2** | 14 CRM tools + pre-fetch + save-message | A fazer |
| **3** | notificar_equipe + designar_lead + dedup + roteamento | A fazer |
| **4** | Follow-up worker (cron + sub-agente) | A fazer |
| **5** | Tools restantes + RAG (buscar_documentos) | A fazer |
| **6** | Canary release (10% → 100% do tráfego) | A fazer |
| **7** | Disparos em massa + limpeza n8n | A fazer |

---

## Decisões de arquitetura

### Por que BullMQ para o buffer de mensagens?

O n8n usa `Redis RPUSH → Wait 10s → Redis GET` para agregar mensagens fragmentadas. Em código, o equivalente com `setTimeout` funcionaria, mas não sobreviveria a um restart do processo. BullMQ com delayed jobs garante que a mensagem seja processada mesmo se o pod reiniciar durante a janela de 10s.

### Por que Zod em todas as tools?

Causa raiz de vários bugs no n8n: o LLM passava parâmetros com tipo errado (número como string, UUID malformado) e o n8n aceitava silenciosamente. Com Zod, a tool rejeita inputs inválidos antes de chamar a API, e o LLM recebe um erro estruturado que o força a corrigir.

### Por que manter gpt-4.1-mini?

Equivalência funcional. Não trocamos modelo sem teste A/B — seria comparar laranjas com laranjas e comprometer a baseline de qualidade atual.

### Por que `exactOptionalPropertyTypes: true` no tsconfig?

Força diferenciação entre `campo: string | undefined` e `campo?: string`. No n8n, vários bugs de "campo presente mas vazio" passavam despercebidos. Com essa flag, o compilador rejeita código que confunde as duas formas.

---

## Referência n8n

| Workflow n8n | ID | Equivalente no código |
|---|---|---|
| agente (principal) | `56f4gE0UKHEXMUfa` | `src/webhook/handler.ts` + `src/agent/rica.ts` |
| notificar_equipe | `FdCc5kuCsjavaPXx` | `src/tools/operations/notificar-equipe.ts` |
| designar_lead | `IvDqiFrUig0OHBbw` | `src/tools/operations/designar-lead.ts` |
| Rica - Follow-up Automatico | `6wbh3Fhzm8KbCkVe` | `src/followup/worker.ts` |
| 14 CRM tools | vários | `src/tools/crm/*.ts` |

---

*Última atualização: Sprint 0 — 26/mai/2026*
