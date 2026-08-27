/**
 * src/routing/executive-router.ts
 *
 * Porta fiel do Code2 do notificar_equipe (confirmado em 26/mai/2026).
 *
 * DIFERENÇAS da versão anterior:
 * - Assinatura expandida: (produto, empresa, mensagem, phone)
 *   O n8n detecta padaria/supermercado/cafeteria no texto combinado dos três campos.
 * - Alexy é catch-all nacional → Alex (não segue regional como padaria)
 * - Treinamentos/PDL → Vanessa (prioridade 1)
 * - Eneagrama/autoconhecimento → Lúcia (prioridade 2)
 * - MKT/Planejamento/Mentoria → Maria Helena (era Helen Monte até 27/08/2026)
 * - Cafeteria → Gabriela Câmara (era Ana Clara até 27/08/2026)
 * - Fallback → 100% Maria Helena (sem hash 50/50 — era bug da versão anterior)
 */

import { EXECUTIVES, type Executive } from './executives.config.js'
import { mapDDDToRegion } from './region-mapper.js'

export type RoutingResult = {
  executive: Executive
  reason: string
  product: string
  region: string
  subregion: string
  state: string
  ddd: number | null
}

/**
 * Detectores de segmento — aplicados sobre texto combinado (produto + empresa + mensagem).
 * Replica a lógica do Code2 que olha múltiplos campos para classificar o segmento.
 */
const IS_PADARIA = /\b(padaria|panificadora|panificadoras|panific|paes|pão|pães|confeitaria)\b/i
const IS_SUPERMERCADO = /\b(supermercado|mercado|atacarejo|atacadao)\b/i
const IS_CAFETERIA = /\b(cafeteria|coffee|cafezinho|cafe gourmet)\b/i

/**
 * Roteia lead para executivo correto.
 * Porta do Code2 do n8n com assinatura expandida.
 *
 * @param produto - Produto/serviço informado pelo lead
 * @param empresa - Nome da empresa do lead (pode ser vazio)
 * @param mensagem - Texto da conversa (para detectar segmento quando produto é genérico)
 * @param phone - Telefone do lead (para extração de DDD/região)
 */
export function routeToExecutive(
  produto: string,
  empresa: string,
  mensagem: string,
  phone: string,
): RoutingResult {
  const p = produto.toLowerCase()
  const textoCompleto = `${p} ${empresa.toLowerCase()} ${mensagem.toLowerCase()}`

  const isPadaria = IS_PADARIA.test(textoCompleto)
  const isSupermercado = IS_SUPERMERCADO.test(textoCompleto)
  const isCafeteria = IS_CAFETERIA.test(textoCompleto)

  const geo = mapDDDToRegion(phone)
  const { region, subregion, state, ddd } = geo

  let executive: Executive
  let reason: string

  // ── 1. TREINAMENTOS / PDL → Vanessa (prioridade máxima) ──────────────────
  if (
    p.includes('treinamento') ||
    p.includes('pdl') ||
    p.includes('p.d.l') ||
    p.includes('programa de desenvolvimento')
  ) {
    executive = EXECUTIVES.VANESSA
    reason = 'Treinamentos/PDL — Vanessa'
  }

  // ── 2. ENEAGRAMA / autoconhecimento → Lúcia ───────────────────────────────
  else if (p.includes('eneagrama') || p.includes('autoconhecimento')) {
    executive = EXECUTIVES.LUCIA
    reason = 'Eneagrama — Lúcia'
  }

  // ── 3. GPS → André (RJ e MG → Patrícia) ───────────────────────────────────
  else if (p.includes('gps')) {
    if (state === 'RJ' || state === 'MG') {
      executive = EXECUTIVES.PATRICIA
      reason = 'GPS — RJ/MG (Patrícia)'
    } else {
      executive = EXECUTIVES.ANDRE
      reason = 'GPS — demais regiões (André)'
    }
  }

  // ── 4. ALEXY (catch-all nacional) → Alex ─────────────────────────────────
  else if (p.includes('alexy')) {
    executive = EXECUTIVES.ALEX
    reason = 'Alexy — Brasil nacional (Alex)'
  }

  // ── 5. PADARIA (regional) ─────────────────────────────────────────────────
  else if (isPadaria) {
    // MG é 'sudeste_outros' no mapa de DDD, mas padaria de MG vai pra Lúcia
    // (não pro Alex). Por isso o Sudeste do Alex exclui MG explicitamente.
    if (subregion === 'sao_paulo' || (subregion === 'sudeste_outros' && state !== 'MG')) {
      executive = EXECUTIVES.ALEX
      reason = 'Padaria — Sudeste SP/ES (Alex)'
    } else if (region === 'norte' || region === 'nordeste') {
      executive = EXECUTIVES.GABRIELA
      reason = 'Padaria — Norte/Nordeste (Gabriela)'
    } else if (subregion === 'rio_de_janeiro' || state === 'MG' || region === 'sul') {
      executive = EXECUTIVES.LUCIA
      reason = 'Padaria — RJ/MG/Sul (Lúcia)'
    } else {
      executive = EXECUTIVES.CAROLINA
      reason = 'Padaria — Brasil/fallback (Carolina)'
    }
  }

  // ── 6. SUPERMERCADO → Irelene ─────────────────────────────────────────────
  else if (isSupermercado) {
    executive = EXECUTIVES.IRELENE
    reason = 'Segmento Supermercado — Irelene'
  }

  // ── 7. CAFETERIA → Gabriela ───────────────────────────────────────────────
  // Era Ana Clara ate 27/08/2026; ela saiu da empresa.
  else if (isCafeteria) {
    executive = EXECUTIVES.GABRIELA
    reason = 'Segmento Cafeteria — Gabriela'
  }

  // ── 8. MKT / Planejamento / Mentoria → Helen ──────────────────────────────
  else if (
    p.includes('marketing') ||
    p.includes('mkt') ||
    p.includes('planejamento estrategico') ||
    p.includes('planejamento estratégico') ||
    p.includes('planejamento comercial') ||
    p.includes('mentoria')
  ) {
    // Era Helen Monte ate 27/08/2026; a pedido dela, passou a vir para a
    // Maria Helena. Mesmo destino do fallback, mas a regra fica explicita para
    // o `reason` do log dizer que veio por MKT, e nao por falta de match.
    executive = EXECUTIVES.MARIA_HELENA
    reason = 'MKT/Planejamento/Mentoria — Maria Helena'
  }

  // ── 9. Fallback → Maria Helena (100%, sem hash) ───────────────────────────
  else {
    executive = EXECUTIVES.MARIA_HELENA
    reason = 'Outros segmentos — Maria Helena (fallback)'
  }

  return { executive, reason, product: produto, region, subregion, state, ddd }
}

/** Monta mensagem WhatsApp para o executivo (Code3 do n8n). */
export function buildExecutiveMessage(params: {
  executiveName: string
  leadName: string
  leadPhone: string
  leadCompany: string
  leadEmail: string
  product: string
  message: string
  resumoDiagnostico?: string | undefined
  state: string
  ddd: number | null
}): string {
  const { executiveName, leadName, leadPhone, leadCompany, leadEmail, product, message, resumoDiagnostico, state, ddd } = params
  const firstName = executiveName.split(' ')[0] ?? executiveName
  const phoneForLink = leadPhone.replace(/^55/, '')

  return (
    `🔥 *NOVO LEAD QUENTINHO!*\n\n` +
    `Oi ${firstName}! 👋 Aqui é a Rica 🤖\n\n` +
    `━━━━━━━━━━━━━━\n📋 *DADOS DO CLIENTE*\n━━━━━━━━━━━━━━\n\n` +
    `👤 *Nome:* ${leadName || 'Não informado'}\n` +
    `🏢 *Empresa:* ${leadCompany || 'Não informada'}\n` +
    `📱 *Tel:* ${leadPhone || 'Não informado'}\n` +
    `📧 *Email:* ${leadEmail || 'Não informado'}\n` +
    `🎯 *Produto:* ${product || 'Não informado'}\n` +
    `📍 *Local:* ${state || 'BR'} (DDD ${ddd ?? 'XX'})\n\n` +
    `━━━━━━━━━━━━━━\n💬 *MENSAGEM DO LEAD*\n━━━━━━━━━━━━━━\n` +
    `_"${message || 'Cliente solicitou contato'}"_\n\n` +
    (resumoDiagnostico
      ? `━━━━━━━━━━━━━━\n📋 *RESUMO DO DIAGNÓSTICO*\n━━━━━━━━━━━━━━\n${resumoDiagnostico}\n\n`
      : '') +
    `🔥 *${firstName}, esse lead está fresquinho!*\n` +
    `Quanto mais rápido você fizer contato, maior a chance de fechar! 💪\n\n` +
    `⚡ *Clique para chamar no WhatsApp:*\nwa.me/${phoneForLink}\n\n` +
    `🤖 _Rica - Assistente de Vendas_`
  )
}

export function buildManagerMessage(params: {
  leadName: string
  product: string
  state: string
  ddd: number | null
  executiveName: string
  reason: string
}): string {
  const { leadName, product, state, ddd, executiveName, reason } = params
  const now = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date())

  return (
    `📊 *LEAD DISTRIBUÍDO*\n\n` +
    `👤 *Lead:* ${leadName || 'Não informado'}\n` +
    `🎯 *Produto:* ${product || 'Não informado'}\n` +
    `📍 *Local:* ${state || 'BR'} (DDD ${ddd ?? 'XX'})\n\n` +
    `➡️ *Direcionado para:* ${executiveName}\n` +
    `📋 *Motivo:* ${reason}\n\n` +
    `⏰ ${now}`
  )
}
