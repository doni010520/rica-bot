# Runbook — Cutover Rica n8n → rica-bot

> **Última atualização**: Sprint 6  
> **Responsável**: Adonias  
> **Rollback**: alterar `CANARY_PERCENTAGE` para 0 e reiniciar o container

---

## Pré-requisitos (fazer ANTES de começar)

```bash
# 1. Verificar preflight — todos os checks devem ser ok ou degraded (não critical)
curl https://your-rica-bot-host.example.com/preflight | jq .

# 2. Confirmar que o prompt está carregado
# Esperado: "rica-principal.md: ~99kb ✓"

# 3. Confirmar tabela de memória no Supabase
# A tabela n8n_chat_histories deve existir. Se não: o rica-bot cria automaticamente.

# 4. Confirmar variáveis no EasyPanel
# Obrigatórias: OPENAI_API_KEY, UAZAPI_TOKEN, DATABASE_URL, REDIS_URL
# Obrigatória para canary: N8N_WEBHOOK_URL=https://your-n8n-host/webhook/path
```

---

## Etapa 0 — Deploy sem tráfego (CANARY_PERCENTAGE=0)

```bash
# No EasyPanel, configurar:
CANARY_PERCENTAGE=0
N8N_WEBHOOK_URL=https://your-n8n-host/webhook/path
```

**Alterar o webhook do uazapi** para apontar para o rica-bot:
- De: `https://your-n8n-host/webhook/path`
- Para: `https://your-rica-bot-host.example.com/webhook/uazapi`

Com `CANARY_PERCENTAGE=0`, o rica-bot recebe tudo mas faz **forward para o n8n** — comportamento idêntico ao anterior.

Validar:
```bash
# Health ok
curl https://your-rica-bot-host.example.com/health

# Métricas subindo
curl https://your-rica-bot-host.example.com/metrics
# webhook.received deve subir a cada mensagem recebida
# webhook.forwarded_n8n deve subir junto (rica-bot forwarding para n8n)
```

---

## Etapa 1 — 10% (monitorar 1-2 horas)

```bash
# EasyPanel: CANARY_PERCENTAGE=10
# Reiniciar container (env vars não recarregam sem restart)
```

**O que monitorar:**
```bash
watch -n 30 'curl -s https://your-rica-bot-host.example.com/metrics | jq .'
```

| Métrica | Esperado |
|---|---|
| `webhook.processed_ricabot` | Subindo (~10% do total) |
| `webhook.forwarded_n8n` | Subindo (~90% do total) |
| `errors.webhook` | Zero ou muito baixo |
| `agent.fallbacks` | Zero ou muito baixo |

**Critério para avançar:** 30+ mensagens processadas sem erros, respostas chegando no WhatsApp.

---

## Etapa 2 — 25% → 50% → 75% → 100%

Repetir a mesma lógica, aguardando 1-2 horas por etapa:

```
CANARY_PERCENTAGE=25  → aguardar
CANARY_PERCENTAGE=50  → aguardar + comparar comportamento rico-bot vs n8n
CANARY_PERCENTAGE=75  → aguardar
CANARY_PERCENTAGE=100 → 🎉 migração completa
```

**Em 100%:** o campo `N8N_WEBHOOK_URL` pode ser deixado configurado (não vai ser usado), mas o n8n deve ser mantido **pausado** (não deletado) por 30 dias para rollback emergencial.

---

## Rollback rápido

```bash
# OPÇÃO 1: voltar para percentual anterior
# EasyPanel: CANARY_PERCENTAGE=0 → restart → tudo volta para n8n

# OPÇÃO 2: rollback total (mudar webhook do uazapi de volta)
# No painel do uazapi, webhook URL → n8n URL original
```

---

## Monitoramento contínuo (após 100%)

```bash
# Dashboard simplificado
watch -n 60 'curl -s https://your-rica-bot-host.example.com/metrics | jq .counters'

# Alertas para investigar:
# - errors.webhook > 5 em 1 hora
# - agent.fallbacks > 3 em 1 hora  
# - webhook.received parou de subir (uazapi desconectou?)
```

---

## Verificações pós-100%

- [ ] Leads novos chegando no CRM em Triagem
- [ ] `notificar_equipe` disparando para executivos
- [ ] Follow-up automático rodando (9h-18h seg-sex)
- [ ] Memória de conversa persistindo entre sessões
- [ ] `LimparDados` funcionando
- [ ] Takeover ("Roberta aqui!") funcionando
- [ ] Candidatos sendo redirecionados para Vanessa

---

## Desligar o n8n (após 30 dias estável)

```bash
# 1. Pausar workflows da Rica no n8n (não deletar)
#    - agente (56f4gE0UKHEXMUfa)
#    - Rica - Follow-up Automatico (6wbh3Fhzm8KbCkVe)
#    - Rica - Follow-up Supabase (4F71spozZtv9ceEO)
# 
# 2. Manter os subworkflows como referência histórica
# 3. Documentar data de desativação no COMECE_AQUI.md
```
