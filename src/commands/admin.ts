/**
 * src/commands/admin.ts
 *
 * Detecção de comandos admin/operador — replica o nó Code + Switch2 do n8n.
 *
 * CONTEXTO (investigado em 26/mai/2026):
 * O nó Code do workflow rico analisa o início da mensagem e roteia:
 *
 *   if (message.startsWith("TreinoIA12") || message.startsWith("AgendaIA12")
 *       || message.startsWith("ArquivosIA12") || message.startsWith("BaseIA12"))
 *     → 'treino'
 *
 *   if (message.startsWith("DisparoRica12"))
 *     → 'disparos'
 *
 *   if (message.startsWith("LimparDados"))
 *     → 'limpar'
 *
 *   else
 *     → 'atendimento' (fluxo normal)
 *
 *   // Caso especial antes de tudo:
 *   if (notification === 'REVOKE')
 *     → 'revoke' (cliente apagou mensagem — ignorar)
 *
 * ATENÇÃO: Comandos são de ADMIN/OPERADOR da Sucesso, NÃO do cliente final.
 * São case-sensitive e sem trim (paridade com n8n).
 *
 * Sprint 5+: implementar fluxos de treino e disparos.
 * Agora: treino/disparos → log + ignorar.
 */

export type AdminCommand = 'limpar' | 'treino' | 'disparos' | 'atendimento' | 'revoke'

// ─── prefixos dos comandos (fonte de verdade) ─────────────────────────────────

const COMMAND_PREFIXES = {
  TREINO: ['TreinoIA12', 'AgendaIA12', 'ArquivosIA12', 'BaseIA12'],
  DISPAROS: ['DisparoRica12'],
  LIMPAR: ['LimparDados'],
} as const

/**
 * Detecta comando admin na mensagem recebida.
 *
 * Réplica exata do Code + Switch2 do n8n:
 * - Case-sensitive (LimparDados ≠ limpardados)
 * - Sem trim (paridade 100% com n8n — documentar divergência se mudar)
 * - startsWith, não includes
 *
 * @param message - Texto da mensagem (não normalizado)
 * @param isRevoke - true se payload.notification === 'REVOKE'
 */
export function detectAdminCommand(message: string, isRevoke = false): AdminCommand {
  // REVOKE tem prioridade — mensagem apagada, ignorar
  if (isRevoke) return 'revoke'

  const m = message ?? ''

  if (COMMAND_PREFIXES.TREINO.some((p) => m.startsWith(p))) return 'treino'
  if (COMMAND_PREFIXES.DISPAROS.some((p) => m.startsWith(p))) return 'disparos'
  if (COMMAND_PREFIXES.LIMPAR.some((p) => m.startsWith(p))) return 'limpar'

  return 'atendimento'
}
