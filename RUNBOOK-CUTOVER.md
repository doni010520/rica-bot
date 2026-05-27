# Runbook — Cutover Rica para o rica-bot

> Migração direta: 100% das mensagens passam a ser processadas pelo rica-bot
> a partir do momento em que o webhook do uazapi é trocado.
>
> **Rollback de emergência**: trocar o webhook do uazapi de volta pro sistema
> antigo no painel uazapi.

---

## 1. Pré-deploy

```bash
# Subir a app no EasyPanel apontando para https://github.com/doni010520/rica-bot
# (branch main, build via Dockerfile)
# Configurar TODAS as env vars (ver README.md / .env.example)
# Aguardar build verde
```

## 2. Validar saúde antes de tocar no webhook

```bash
# Liveness
curl https://your-rica-bot-host.example.com/health

# Readiness (DB)
curl https://your-rica-bot-host.example.com/ready

# Preflight — todos os checks críticos OK
curl https://your-rica-bot-host.example.com/preflight | jq .
```

`canProceed: true` e nenhum check em `critical`. Se algum falhar, **não trocar** o webhook ainda — investigar.

## 3. Trocar o webhook do uazapi

No painel uazapi, alterar a URL do webhook:

- **De**: URL antiga do sistema anterior
- **Para**: `https://your-rica-bot-host.example.com/webhook/uazapi`

A partir desse instante, **toda mensagem** é processada pelo rica-bot.

## 4. Monitoramento das primeiras horas

```bash
watch -n 30 'curl -s https://your-rica-bot-host.example.com/metrics | jq .'
```

| Métrica | Esperado |
|---|---|
| `webhook.received` | Subindo a cada mensagem recebida |
| `webhook.processed` | Subindo junto |
| `agent.calls` | Subindo proporcionalmente |
| `errors.webhook` | Zero ou muito baixo |
| `agent.fallbacks` | Zero ou muito baixo |

Logs em tempo real no EasyPanel pra observar comportamento real.

## 5. Verificações funcionais (após primeiras horas)

- [ ] Leads novos chegando no CRM em Triagem
- [ ] `notificar_equipe` disparando para executivos
- [ ] Follow-up automático rodando (9h-18h seg-sex)
- [ ] Memória de conversa persistindo entre sessões
- [ ] `LimparDados` funcionando
- [ ] Takeover (`Roberta aqui!` / `tá mais!`) funcionando
- [ ] Candidatos sendo redirecionados para o RH

## 6. Rollback de emergência

Se algo der errado nas primeiras horas:

1. Painel uazapi → alterar webhook de volta pra URL do sistema antigo
2. O sistema antigo precisa estar **pausado mas não deletado** durante esse período
3. Identificar e corrigir o problema no rica-bot
4. Tentar novamente

## 7. Desligar o sistema antigo (após período estável)

Recomendação: aguardar 30 dias de operação estável antes de desligar o sistema antigo. Durante esse período, manter os workflows pausados mas presentes — apenas como rede de segurança operacional.
