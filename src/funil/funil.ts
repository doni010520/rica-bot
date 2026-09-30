/**
 * src/funil/funil.ts
 *
 * Funil por CAMPANHA da Rica (Mentoria, Jornada Online, GPS) — base comum da
 * força-tarefa comercial de set/2026.
 *
 * Uma linha por lead+campanha em `rica_lead_funil` (etapa atual + campos do
 * diagnóstico: dor, objetivo, pilar, temperatura, reunião...) e uma linha por
 * acontecimento em `rica_funil_eventos` (linha do tempo com horário), que é o que
 * os relatórios do copiloto e o painel semanal contam.
 *
 * Quem escreve aqui:
 *   - o webhook (lead falou / Rica respondeu / campanha reconhecida pela msg do anúncio)
 *   - as tools da Rica (registrar_funil, nao_contatar, agenda da Mentoria, pendências)
 *   - a cadência de follow-up (passo alcançado)
 *
 * Tudo fail-soft: erro de banco aqui NUNCA derruba o atendimento.
 */

import type { Pool } from 'pg'
import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'

export type Campanha = 'mentoria' | 'jdl' | 'gps' | 'outro'

export const ETAPAS = [
  'novo',                   // chegou pelo anúncio
  'rica_iniciou',           // Rica mandou a 1ª mensagem
  'engajou',                // lead respondeu
  'diagnostico_iniciado',   // 2+ interações sobre o problema
  'dor_identificada',       // dor registrada
  'qualificado',            // critérios de qualificação atingidos
  'agendamento_oferecido',  // horários do André mostrados (Mentoria)
  'link_agenda_enviado',    // link da agenda do André enviado (GPS)
  'reuniao_agendada',       // evento criado na agenda do André (Mentoria / GPS)
  'transferido',            // handoff ao executivo sem reunião marcada
  'oferta_solicitada',      // pediu valor/programa/link (Jornada)
  'link_enviado',           // link de compra entregue (Jornada)
  'compra_confirmada',      // comprou
  'nutricao',               // cadência esgotada sem resposta
  'nao_contatar',           // pediu para não receber mais mensagens
  'perdido',
  // Pós-agendamento — informados pelo André ao copiloto (GPS, manual seções 11-13)
  'confirmado_andre',
  'reuniao_realizada',
  'no_show',
  'remarcado',
  'vendido',
] as const

export type Etapa = (typeof ETAPAS)[number]

/** Ordem das etapas: o funil só AVANÇA (etapa menor não sobrescreve maior). */
const ORDEM: Record<string, number> = Object.fromEntries(ETAPAS.map((e, i) => [e, i]))

/** Etapas terminais/laterais que sempre podem ser gravadas. */
const SEMPRE_GRAVA = new Set<string>([
  'nao_contatar', 'perdido', 'nutricao', 'compra_confirmada',
  'confirmado_andre', 'reuniao_realizada', 'no_show', 'remarcado', 'vendido',
])

/**
 * Etapas em que o lead do GPS já é do André: a Rica NÃO fala mais com ele
 * (manual GPS, seção 12 — "a RICA não volta a falar com o cliente").
 */
export const ETAPAS_POS_HANDOFF = new Set<string>([
  'reuniao_agendada', 'transferido', 'confirmado_andre', 'reuniao_realizada', 'no_show', 'remarcado', 'vendido',
])

/** Timestamp que cada etapa carimba (só na primeira vez). */
const CARIMBO: Partial<Record<Etapa, string>> = {
  rica_iniciou: 'first_rica_message_at',
  engajou: 'first_lead_reply_at',
  qualificado: 'qualified_at',
  agendamento_oferecido: 'scheduling_options_shown_at',
  link_agenda_enviado: 'link_agenda_enviado_at',
  remarcado: 'remarcado_at',
  reuniao_agendada: 'meeting_booked_at',
  transferido: 'handoff_at',
  link_enviado: 'link_enviado_at',
  compra_confirmada: 'compra_confirmada_at',
}

/** Campos livres que a Rica pode preencher. Nome da coluna = nome do campo. */
export const CAMPOS_TEXTO = [
  'nome', 'padaria', 'origem', 'interesse_do_anuncio', 'dor_principal', 'impacto',
  'objetivo_declarado', 'pilar_aderente', 'decisor', 'tamanho_operacao', 'temperatura',
  'pergunta_de_compra', 'objecao', 'meeting_status',
  // GPS (manual, seções 16 a 18)
  'papel', 'categoria_dor', 'cidade', 'classe', 'email',
] as const

export type CamposFunil = Partial<Record<(typeof CAMPOS_TEXTO)[number], string | undefined>> & {
  consentimento_handoff?: boolean | undefined
  meeting_start_at?: string | undefined
  meeting_duration_minutes?: number | undefined
  calendar_event_id?: string | undefined
  scheduling_offered_slots?: unknown
  deal_id?: string | undefined
}

export type FunilRow = {
  campanha: Campanha
  etapa: Etapa
  nome: string | null
  padaria: string | null
  origem: string | null
  interesse_do_anuncio: string | null
  dor_principal: string | null
  impacto: string | null
  objetivo_declarado: string | null
  pilar_aderente: string | null
  decisor: string | null
  tamanho_operacao: string | null
  temperatura: string | null
  pergunta_de_compra: string | null
  objecao: string | null
  meeting_status: string | null
  papel: string | null
  categoria_dor: string | null
  cidade: string | null
  classe: string | null
  handoff_at: Date | null
  meeting_start_at: Date | null
  link_enviado_at: Date | null
  nao_contatar: boolean
  followup_step_reached: number
  message_count_rica: number
  deal_id: string | null
}

export function digits(phone: string): string {
  return (phone ?? '').replace(/\D/g, '')
}

// ─── reconhecimento da campanha pela mensagem pronta do anúncio ─────────────
// Mesmos trechos de pm-ia-consultorias/api/src/services/campanhas.js — campanha
// nova com outra mensagem pronta precisa entrar nos DOIS lugares.

function semAcento(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const PADROES_ANUNCIO: Array<{ campanha: Campanha; origem: string; re: RegExp }> = [
  { campanha: 'mentoria', origem: 'Anúncio - Mentoria Coletiva', re: /quero saber mais sobre a mentoria padaria lucrativa/ },
  { campanha: 'jdl', origem: 'Anúncio - Jornada Online', re: /informa.*sobre a jdl online|vim pelo site da jdl/ },
  { campanha: 'gps', origem: 'Anúncio - GPS Padaria', re: /quero saber mais sobre a gps padaria/ },
]

/** Reconhece a campanha pela mensagem pronta do anúncio. null se não for anúncio. */
export function detectarCampanhaDoAnuncio(texto: string): { campanha: Campanha; origem: string } | null {
  const t = semAcento(texto)
  const hit = PADROES_ANUNCIO.find((p) => p.re.test(t))
  return hit ? { campanha: hit.campanha, origem: hit.origem } : null
}

// ─── escrita ────────────────────────────────────────────────────────────────

/**
 * Cria/atualiza a linha do lead na campanha. A etapa só avança (ou vai para
 * uma etapa terminal). Carimba o horário da etapa na primeira vez e registra o
 * evento na linha do tempo.
 */
export async function atualizarFunil(
  pool: Pool,
  phone: string,
  campanha: Campanha,
  opts: { etapa?: Etapa | undefined; campos?: CamposFunil | undefined; evento?: string | undefined; dados?: unknown } = {},
): Promise<void> {
  const tel = digits(phone)
  if (tel.length < 12) return
  const { etapa, campos = {}, evento, dados } = opts
  try {
    await pool.query(
      `INSERT INTO rica_lead_funil (organization_id, phone, campanha)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, phone, campanha) DO NOTHING`,
      [env.ORG_ID, tel, campanha],
    )

    const sets: string[] = ['updated_at = NOW()', 'last_interaction_at = NOW()']
    const vals: unknown[] = [env.ORG_ID, tel, campanha]
    const add = (col: string, v: unknown, soSeVazio = false) => {
      vals.push(v)
      sets.push(soSeVazio ? `${col} = COALESCE(${col}, $${vals.length})` : `${col} = $${vals.length}`)
    }

    for (const c of CAMPOS_TEXTO) {
      const v = campos[c]
      if (typeof v === 'string' && v.trim()) add(c, v.trim().slice(0, 2000))
    }
    if (campos.nome?.trim()) sets.push('name_captured_at = COALESCE(name_captured_at, NOW())')
    if (campos.padaria?.trim()) sets.push('bakery_captured_at = COALESCE(bakery_captured_at, NOW())')
    if (typeof campos.consentimento_handoff === 'boolean') add('consentimento_handoff', campos.consentimento_handoff)
    if (campos.meeting_start_at) add('meeting_start_at', campos.meeting_start_at)
    if (campos.meeting_duration_minutes) add('meeting_duration_minutes', campos.meeting_duration_minutes)
    if (campos.calendar_event_id) add('calendar_event_id', campos.calendar_event_id)
    if (campos.scheduling_offered_slots !== undefined) add('scheduling_offered_slots', JSON.stringify(campos.scheduling_offered_slots))
    if (campos.deal_id) add('deal_id', campos.deal_id, true)

    if (etapa) {
      vals.push(etapa)
      const p = vals.length
      const ordem = ORDEM[etapa] ?? 0
      // Avança só se a etapa nova for maior que a atual (ou for terminal).
      sets.push(
        SEMPRE_GRAVA.has(etapa)
          ? `etapa = $${p}`
          : `etapa = CASE WHEN ${ordemSql('etapa')} < ${ordem} THEN $${p} ELSE etapa END`,
      )
      const carimbo = CARIMBO[etapa]
      if (carimbo) sets.push(`${carimbo} = COALESCE(${carimbo}, NOW())`)
      if (etapa === 'nao_contatar') sets.push('nao_contatar = true')
      if (etapa === 'agendamento_oferecido') sets.push('scheduling_invite_at = COALESCE(scheduling_invite_at, NOW())')
      if (etapa === 'reuniao_agendada') sets.push('handoff_at = COALESCE(handoff_at, NOW())')
    }

    await pool.query(
      `UPDATE rica_lead_funil SET ${sets.join(', ')}
       WHERE organization_id = $1 AND phone = $2 AND campanha = $3`,
      vals,
    )

    const nomeEvento = evento ?? (etapa ? `etapa:${etapa}` : undefined)
    if (nomeEvento) await registrarEvento(pool, tel, campanha, nomeEvento, dados ?? (Object.keys(campos).length ? campos : undefined))
  } catch (err) {
    logger.warn({ err, phone: tel.slice(-4), campanha }, 'funil: falha ao atualizar (ignorado)')
  }
}

function ordemSql(col: string): string {
  // Lead em nutrição que volta a responder retoma o funil: nutrição vale -1.
  const casos = ETAPAS.map((e, i) => `WHEN '${e}' THEN ${e === 'nutricao' ? -1 : i}`).join(' ')
  return `(CASE ${col} ${casos} ELSE 0 END)`
}

export async function registrarEvento(
  pool: Pool,
  phone: string,
  campanha: Campanha,
  evento: string,
  dados?: unknown,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO rica_funil_eventos (organization_id, phone, campanha, evento, dados)
       VALUES ($1, $2, $3, $4, $5)`,
      [env.ORG_ID, digits(phone), campanha, evento.slice(0, 60), dados === undefined ? null : JSON.stringify(dados)],
    )
  } catch (err) {
    logger.warn({ err, evento }, 'funil: falha ao registrar evento (ignorado)')
  }
}

// ─── leitura ────────────────────────────────────────────────────────────────

/** Campanha mais recente do lead (a que está em andamento). null se não houver. */
export async function funilAtual(pool: Pool, phone: string): Promise<FunilRow | null> {
  try {
    const r = await pool.query<FunilRow>(
      `SELECT campanha, etapa, nome, padaria, origem, interesse_do_anuncio, dor_principal, impacto,
              objetivo_declarado, pilar_aderente, decisor, tamanho_operacao, temperatura,
              pergunta_de_compra, objecao, meeting_status, papel, categoria_dor, cidade, classe,
              handoff_at, meeting_start_at, link_enviado_at, nao_contatar, followup_step_reached,
              message_count_rica, deal_id
       FROM rica_lead_funil
       WHERE organization_id = $1 AND phone = $2
       ORDER BY last_interaction_at DESC NULLS LAST
       LIMIT 1`,
      [env.ORG_ID, digits(phone)],
    )
    return r.rows[0] ?? null
  } catch (err) {
    logger.warn({ err }, 'funil: falha ao ler (ignorado)')
    return null
  }
}

/** O lead pediu para não receber mais mensagens (em qualquer campanha)? */
export async function naoContatar(pool: Pool, phone: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT 1 FROM rica_lead_funil WHERE organization_id = $1 AND phone = $2 AND nao_contatar LIMIT 1`,
      [env.ORG_ID, digits(phone)],
    )
    return (r.rowCount ?? 0) > 0
  } catch {
    return false
  }
}

// ─── ganchos do webhook ─────────────────────────────────────────────────────

/**
 * Lead mandou mensagem. Se for a mensagem pronta de um anúncio, abre/atualiza
 * a campanha. Em qualquer caso marca "engajou" na campanha em andamento (a
 * partir da 2ª mensagem — a 1ª é a do anúncio) e encerra o resgate, se houver.
 */
export async function aoReceberDoLead(pool: Pool, phone: string, texto: string, dealId?: string): Promise<void> {
  try {
    const deal = dealId ? { deal_id: dealId } : {}
    const anuncio = detectarCampanhaDoAnuncio(texto)
    if (anuncio) {
      await atualizarFunil(pool, phone, anuncio.campanha, {
        etapa: 'novo',
        campos: { origem: anuncio.origem, ...deal },
        evento: 'lead_created',
      })
      return
    }
    // Respondeu a uma mensagem do resgate (inclusive a 3ª, que já encerra a
    // sequência)? Encerra e garante que a conversa siga como Jornada.
    const resgate = await pool.query(
      `UPDATE rica_resgate SET respondeu_at = NOW(), encerrado = true
       WHERE organization_id = $1 AND phone = $2 AND respondeu_at IS NULL AND passo > 0
         AND ultimo_envio_at > NOW() - INTERVAL '15 days'
       RETURNING campanha`,
      [env.ORG_ID, digits(phone)],
    )
    if (resgate.rows.length) {
      await atualizarFunil(pool, phone, 'jdl', {
        etapa: 'engajou',
        campos: { origem: 'Resgate - Jornada Online', ...deal },
        evento: 'resgate_respondeu',
      })
      return
    }

    const atual = await funilAtual(pool, phone)
    if (atual) {
      await atualizarFunil(pool, phone, atual.campanha, { etapa: 'engajou', evento: 'lead_reply', campos: deal })
      // Primeira resposta do lead (manual GPS, seção 18) — grava só uma vez.
      await pool.query(
        `UPDATE rica_lead_funil SET primeira_resposta = $4
         WHERE organization_id = $1 AND phone = $2 AND campanha = $3 AND primeira_resposta IS NULL`,
        [env.ORG_ID, digits(phone), atual.campanha, texto.slice(0, 1000)],
      ).catch(() => {})
    }
  } catch (err) {
    logger.warn({ err }, 'funil: aoReceberDoLead falhou (ignorado)')
  }
}

/** Rica respondeu o lead: conta mensagens e marca "rica_iniciou" na 1ª. */
export async function aoResponderLead(pool: Pool, phone: string): Promise<void> {
  try {
    const atual = await funilAtual(pool, phone)
    if (!atual) return
    await pool.query(
      `UPDATE rica_lead_funil SET message_count_rica = message_count_rica + 1
       WHERE organization_id = $1 AND phone = $2 AND campanha = $3`,
      [env.ORG_ID, digits(phone), atual.campanha],
    )
    if (atual.etapa === 'novo') await atualizarFunil(pool, phone, atual.campanha, { etapa: 'rica_iniciou' })
  } catch (err) {
    logger.warn({ err }, 'funil: aoResponderLead falhou (ignorado)')
  }
}

const PRIMEIRA_RESPOSTA: Partial<Record<Campanha, string>> = {
  jdl:
    'PRIMEIRA RESPOSTA (lead do anúncio da Jornada): se ele NÃO pediu valor, link ou para comprar, use a ABERTURA do ' +
    'fluxo_venda — apresente-se e pergunte o que chamou atenção (margem, desperdícios ou gestão). "Quero informações" ' +
    'também é ABERTURA. NÃO mande a APRESENTAÇÃO do produto, conteúdo, acesso nem preço nesta mensagem. Uma mensagem só.',
  gps:
    'PRIMEIRA RESPOSTA (lead do anúncio do GPS): use o texto de ENTRADA DO LEAD do fluxo_pre_vendas_gps — apresente-se ' +
    'e pergunte o que mais chamou atenção no anúncio. NÃO apresente a plataforma, conteúdos nem preço nesta mensagem, ' +
    'e NÃO peça nome nem padaria.',
  mentoria:
    'PRIMEIRA RESPOSTA (lead do anúncio da Mentoria): use a ABERTURA do fluxo_pre_vendas — apresente-se e pergunte o que ' +
    'fez a pessoa parar no anúncio. NÃO explique a Mentoria nem o formato nesta mensagem.',
}

/**
 * GPS no meio da conversa (30/09): em leads reais a Rica recomeçava do zero num
 * "Bom dia" ("Sucesso no Resultado, como posso te chamar?"), ignorava "como
 * funciona?" e fazia pergunta a mais depois da dor. O próximo passo do manual
 * depende do estado — dizer qual é, em vez de deixar o modelo escolher.
 */
export function orientacaoGps(f: Pick<FunilRow, 'etapa' | 'dor_principal'> & { message_count_rica?: number }): string {
  if (ETAPAS_POS_HANDOFF.has(f.etapa) || f.etapa === 'nao_contatar') return ''
  const base = 'CONTINUE o fluxo_pre_vendas_gps: você é a Rica, da Sucesso na Padaria; NÃO se reapresente, NÃO recomece a conversa e NÃO peça nome nem padaria.'
  if (f.etapa === 'link_agenda_enviado') {
    return `${base} O link da agenda do André JÁ FOI enviado: responda o que o lead disser e reforce que é só escolher o horário no link (sem gerar outro, a não ser que ele diga que o link não abriu ou que nenhum horário serve).`
  }
  if (f.dor_principal) {
    return `${base} A DOR JÁ FOI IDENTIFICADA ("${f.dor_principal}"): NÃO faça mais perguntas de qualificação. Nesta resposta: espelhamento + apresentação curta + chame enviar_link_agenda_andre e mande o convite com o link.`
  }
  // Abertura + 2 perguntas já feitas (manual: "no máximo 2 a 3 perguntas").
  if ((f.message_count_rica ?? 0) >= 3) {
    return `${base} Você JÁ FEZ as perguntas de qualificação. Se o lead contou algum interesse ou desafio, NÃO pergunte mais nada: espelhe o que ele disse, apresente a GPS em uma frase, chame enviar_link_agenda_andre e mande o convite com o link. Só pergunte de novo se ele ainda não disse nada sobre a padaria.`
  }
  return (
    `${base} Próximo passo: se o lead só cumprimentou ("bom dia", "oi") ou não soube dizer o que chamou atenção, use o FACILITADOR ` +
    '(passo 2, as 4 opções). Se perguntou "como funciona" ou algo da plataforma, responda em UMA frase curta com as informações ' +
    'oficiais e emende o FACILITADOR. Se ele disse um interesse (equipe, gestão, vendas, atualização), faça UMA pergunta de ' +
    'aprofundamento (passo 3) e, na resposta seguinte, vá para o link. No máximo 2 perguntas antes do link.'
  )
}

/** Bloco injetado no prompt: em que campanha e etapa o lead está. */
export function blocoFunilParaPrompt(f: FunilRow | null): string {
  if (!f) return ''
  const linhas = [
    `<funil_do_lead>`,
    `CAMPANHA: ${f.campanha}`,
    `ETAPA: ${f.etapa}`,
  ]
  const campos: Array<[string, unknown]> = [
    ['NOME', f.nome], ['PADARIA', f.padaria], ['INTERESSE_DO_ANUNCIO', f.interesse_do_anuncio],
    ['DOR_PRINCIPAL', f.dor_principal], ['IMPACTO', f.impacto], ['OBJETIVO_DECLARADO', f.objetivo_declarado],
    ['PILAR_ADERENTE', f.pilar_aderente], ['DECISOR', f.decisor], ['TEMPERATURA', f.temperatura],
    ['PAPEL', f.papel], ['CATEGORIA_DOR', f.categoria_dor], ['CIDADE', f.cidade], ['CLASSE', f.classe],
    ['PERGUNTA_DE_COMPRA', f.pergunta_de_compra], ['OBJECAO', f.objecao], ['REUNIAO', f.meeting_status],
    ['LINK_ENVIADO', f.link_enviado_at ? 'sim' : ''],
  ]
  for (const [k, v] of campos) if (v) linhas.push(`${k}: ${String(v)}`)
  linhas.push(`Use estes dados: NÃO pergunte de novo o que já está preenchido.`)
  // Primeira resposta ao lead do anúncio: o modelo tendia a despejar a
  // apresentação do produto (JDL e GPS, 23-29/09) em vez da abertura da campanha.
  const primeira = f.etapa === 'novo' ? PRIMEIRA_RESPOSTA[f.campanha] : undefined
  if (primeira) linhas.push(primeira)
  else if (f.campanha === 'gps') {
    const o = orientacaoGps(f)
    if (o) linhas.push(o)
  }
  linhas.push(`</funil_do_lead>`)
  return linhas.join('\n')
}

/**
 * GPS: o lead já foi entregue ao André (agendou pelo link ou foi transferido)?
 * Então a Rica não fala mais com ele (manual, seção 12) — quem chama é o
 * webhook, que repassa a mensagem ao André em vez de responder.
 * Vale por GPS_SILENCIO_POS_HANDOFF_DIAS depois do handoff.
 */
export async function gpsEntregueAoAndre(pool: Pool, phone: string): Promise<{ nome: string | null } | null> {
  try {
    const r = await pool.query<{ nome: string | null }>(
      `SELECT f.nome FROM rica_lead_funil f
       WHERE f.organization_id = $1 AND f.phone = $2 AND f.campanha = 'gps'
         AND f.etapa = ANY($3::text[])
         AND COALESCE(f.handoff_at, f.updated_at) > NOW() - make_interval(days => $4)
       UNION ALL
       SELECT NULL FROM rica_agenda_links l
       WHERE l.organization_id = $1 AND l.phone = $2 AND l.campanha = 'gps'
         AND l.status IN ('agendado', 'agendando')
         AND l.created_at > NOW() - make_interval(days => $4)
       LIMIT 1`,
      [env.ORG_ID, digits(phone), [...ETAPAS_POS_HANDOFF], env.GPS_SILENCIO_POS_HANDOFF_DIAS],
    )
    return r.rows.length ? { nome: r.rows[0]?.nome ?? null } : null
  } catch (err) {
    logger.warn({ err }, 'funil: falha ao checar handoff do GPS (ignorado)')
    return null
  }
}
