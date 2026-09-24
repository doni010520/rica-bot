/**
 * src/tools/operations/campanhas.ts
 *
 * Tools das campanhas comerciais (força-tarefa set/2026):
 *
 *   registrar_funil          → etapa + diagnóstico do lead (dor, objetivo, pilar...)
 *   nao_contatar             → lead pediu para parar: sai de todas as cadências
 *   consultar_horarios_andre → horários LIVRES do André hoje e amanhã (Google Agenda)
 *   agendar_reuniao_andre    → cria a reunião de 30 min e faz o handoff com a ficha
 *   handoff_mentoria         → handoff SEM reunião (sem horário, outra data, agenda
 *                              desconectada, lead quer falar já)
 *   registrar_pendencia_jdl  → aluno sem acesso / reembolso → avisa e acompanha
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { Pool } from 'pg'
import { crmRequest, CrmApiError } from '../../lib/crm-client.js'
import { logger } from '../../observability/logger.js'
import { env } from '../../lib/env.js'
import { EXECUTIVES } from '../../routing/executives.config.js'
import { cancelLeadFollowup } from '../../followup/lead-followup.js'
import { atualizarFunil, funilAtual, ETAPAS, type Campanha } from '../../funil/funil.js'
import { handoffEstruturado, resumoDaFicha, type Ficha } from '../../funil/handoff.js'
import { criarPendencia } from '../../funil/pendencias.js'

const CAMPANHAS = ['mentoria', 'jdl', 'gps', 'outro'] as const

const FichaSchema = z.object({
  nome: z.string().optional(),
  padaria: z.string().optional(),
  origem: z.string().optional().describe('Ex.: "Anúncio - Mentoria Coletiva"'),
  interesse_do_anuncio: z.string().optional().describe('O que chamou atenção no anúncio (lucro, produção, vendas, operação...)'),
  dor_principal: z.string().optional().describe('A dor com as palavras do lead'),
  impacto: z.string().optional().describe('Como o problema afeta resultado/rotina'),
  objetivo_declarado: z.string().optional().describe('O que o lead quer melhorar — LITERAL, com as palavras dele'),
  pilar_aderente: z.enum(['ADM/Financeiro', 'Produção', 'Vendas/Operação']).optional(),
  decisor: z.string().optional().describe('sim / não / sócio'),
  tamanho_operacao: z.string().optional().describe('Ex.: "18 colaboradores"'),
  temperatura: z.enum(['quente', 'morna', 'fria']).optional(),
  pergunta_de_compra: z.string().optional().describe('Ex.: "valor e próxima turma"'),
  objecao: z.string().optional().describe('Objeção citada (preço, tempo, sócio...)'),
})

/** Número de alguém é o próprio lead desta conversa (tools só agem sobre ele). */
export function buildCampanhasTools(phone: string, pool: Pool) {
  const log = logger.child({ phone: phone.slice(-4), context: 'campanhas-tool' })
  const andre = EXECUTIVES.ANDRE

  async function campanhaAtual(padrao: Campanha = 'mentoria'): Promise<Campanha> {
    return (await funilAtual(pool, phone))?.campanha ?? padrao
  }

  async function dealIdDoLead(): Promise<string | undefined> {
    return (await funilAtual(pool, phone))?.deal_id ?? undefined
  }

  // ── registrar_funil ───────────────────────────────────────────────────────
  const registrar_funil = tool({
    description:
      'Registra em que ETAPA do funil o lead está e o que ele contou (dor, objetivo, pilar, temperatura...). ' +
      'Chame SEMPRE que o lead der uma informação nova do diagnóstico ou avançar de etapa — em silêncio, sem avisar o lead. ' +
      'Etapas: engajou, diagnostico_iniciado, dor_identificada, qualificado, oferta_solicitada (pediu valor/link da Jornada), ' +
      'link_enviado (você mandou o link de compra), compra_confirmada (lead disse que comprou).',
    parameters: FichaSchema.extend({
      campanha: z.enum(CAMPANHAS).describe('mentoria = Mentoria Padaria Lucrativa; jdl = Jornada da Lucratividade Online; gps = GPS Padaria'),
      etapa: z.enum(ETAPAS).optional(),
    }),
    execute: async ({ campanha, etapa, ...campos }) => {
      await atualizarFunil(pool, phone, campanha, { etapa, campos })
      log.info({ campanha, etapa }, 'Funil registrado')
      return { success: true }
    },
  })

  // ── nao_contatar ──────────────────────────────────────────────────────────
  const nao_contatar = tool({
    description:
      'O lead pediu para NÃO receber mais mensagens ("para de me mandar mensagem", "não tenho interesse, não me chame mais"). ' +
      'Remove de TODAS as cadências e do resgate. Depois responda com respeito, sem insistir.',
    parameters: z.object({ motivo: z.string().optional() }),
    execute: async ({ motivo }) => {
      const campanha = await campanhaAtual('outro')
      await atualizarFunil(pool, phone, campanha, { etapa: 'nao_contatar', evento: 'opt_out', dados: { motivo } })
      await cancelLeadFollowup(phone)
      await pool.query(
        `UPDATE rica_resgate SET encerrado = true WHERE organization_id = $1 AND phone = $2`,
        [env.ORG_ID, phone.replace(/\D/g, '')],
      ).catch(() => {})
      log.info('Lead pediu para não ser contatado')
      return { success: true }
    },
  })

  // ── consultar_horarios_andre ──────────────────────────────────────────────
  const consultar_horarios_andre = tool({
    description:
      'Consulta a agenda REAL do André e devolve os horários LIVRES de 30 min de HOJE e AMANHÃ (fuso de Recife). ' +
      'Chame ANTES de oferecer qualquer horário — nunca invente horário. Ofereça de 2 a 4 opções, priorizando hoje.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const r = await crmRequest<{ conectado: boolean; slots: Array<{ inicio: string; rotulo: string }> }>(
          '/api/rica/agenda/disponibilidade',
          { params: { executivo_email: andre.email, duracao: '30' }, operationName: 'agenda_disponibilidade', timeoutMs: 15_000 },
        )
        if (!r.conectado) {
          return { conectado: false, slots: [], instrucao: 'Agenda do André não está conectada. Use handoff_mentoria com situacao="agenda_nao_conectada" e diga ao lead que o André vai chamar para combinar o melhor horário.' }
        }
        const slots = r.slots.slice(0, 8)
        const campanha = await campanhaAtual()
        await atualizarFunil(pool, phone, campanha, {
          etapa: 'agendamento_oferecido',
          campos: { scheduling_offered_slots: slots.map((s) => s.rotulo) },
          evento: 'scheduling_options_shown',
        })
        if (slots.length === 0) {
          return { conectado: true, slots: [], instrucao: 'Sem horário hoje e amanhã. NÃO ofereça outras datas. Use handoff_mentoria com situacao="sem_horario" e diga que o André vai chamar ainda hoje.' }
        }
        return { conectado: true, slots, instrucao: 'Ofereça de 2 a 4 destes rótulos ao lead. Guarde o campo "inicio" do escolhido para agendar_reuniao_andre.' }
      } catch (err) {
        log.warn({ err }, 'consultar_horarios_andre falhou')
        return { conectado: false, slots: [], instrucao: 'Não consegui ler a agenda agora. Use handoff_mentoria com situacao="agenda_nao_conectada".' }
      }
    },
  })

  // ── agendar_reuniao_andre ─────────────────────────────────────────────────
  const agendar_reuniao_andre = tool({
    description:
      'Marca a reunião de 30 min do lead com o André no horário ESCOLHIDO pelo lead (um dos devolvidos por consultar_horarios_andre) ' +
      'e entrega ao André a ficha completa + data/hora. Valida de novo se o horário ainda está livre. ' +
      'Só confirme a reunião ao lead se voltar success=true.',
    parameters: FichaSchema.extend({
      inicio: z.string().describe('Campo "inicio" (ISO) do horário escolhido, exatamente como veio de consultar_horarios_andre'),
    }),
    execute: async ({ inicio, ...ficha }) => {
      const campanha = await campanhaAtual()
      const dealId = await dealIdDoLead()
      const completa: Ficha = { ...ficha, produto: 'Mentoria Padaria Lucrativa' }
      try {
        const r = await crmRequest<{ ok: boolean; event_id: string; inicio: string; rotulo: string }>(
          '/api/rica/agenda/agendar',
          {
            method: 'POST',
            body: {
              executivo_email: andre.email,
              inicio,
              duracao: 30,
              lead: { nome: ficha.nome, telefone: phone, padaria: ficha.padaria },
              resumo: resumoDaFicha({ ...((await funilAtual(pool, phone)) ?? {}), ...ficha } as unknown as Ficha),
              deal_id: dealId,
            },
            operationName: 'agenda_agendar',
            timeoutMs: 20_000,
          },
        )
        await handoffEstruturado(pool, {
          telefone: phone,
          campanha,
          exec: andre,
          ficha: completa,
          reuniao: { tipo: 'agendada', rotulo: r.rotulo, inicioIso: r.inicio, eventId: r.event_id },
          dealId,
        })
        return { success: true, confirmado: r.rotulo, instrucao: `Confirme ao lead: reunião com o André ${r.rotulo}, 30 minutos, por aqui no WhatsApp/link que ele enviar. Depois PARE de vender.` }
      } catch (err) {
        const body = err instanceof CrmApiError ? (err.body as { motivo?: string; slots?: unknown[] }) : undefined
        if (body?.motivo === 'horario_indisponivel') {
          return { success: false, motivo: 'horario_indisponivel', slots: body.slots ?? [], instrucao: 'Esse horário acabou de ser ocupado. Ofereça os slots devolvidos aqui.' }
        }
        log.warn({ err }, 'agendar_reuniao_andre falhou — handoff sem reunião')
        await handoffEstruturado(pool, { telefone: phone, campanha, exec: andre, ficha: completa, reuniao: { tipo: 'agenda_nao_conectada' }, dealId })
        return { success: false, motivo: 'erro_agenda', instrucao: 'Não consegui marcar na agenda. Já passei o caso ao André: diga ao lead que o André vai chamar para confirmar o horário.' }
      }
    },
  })

  // ── handoff_mentoria ──────────────────────────────────────────────────────
  const handoff_mentoria = tool({
    description:
      'Entrega o lead ao André com a ficha completa SEM reunião marcada. Use quando: não há horário hoje/amanhã (sem_horario), ' +
      'o lead pediu data depois de amanhã (pediu_outra_data), a agenda não está conectada/falhou (agenda_nao_conectada), ' +
      'ou o lead quer falar com alguém agora (sem_reuniao). Nunca transfira sem preencher dor e objetivo.',
    parameters: FichaSchema.extend({
      situacao: z.enum(['sem_horario', 'pediu_outra_data', 'agenda_nao_conectada', 'sem_reuniao']),
      pedido_de_data: z.string().optional().describe('O que o lead pediu, quando situacao=pediu_outra_data'),
    }),
    execute: async ({ situacao, pedido_de_data, ...ficha }) => {
      const campanha = await campanhaAtual()
      const reuniao =
        situacao === 'pediu_outra_data' ? { tipo: 'pediu_outra_data' as const, pedido: pedido_de_data ?? 'outra data' }
        : { tipo: situacao }
      await handoffEstruturado(pool, {
        telefone: phone,
        campanha,
        exec: andre,
        ficha: { ...ficha, produto: campanha === 'jdl' ? 'Jornada Online' : 'Mentoria Padaria Lucrativa' },
        reuniao,
        dealId: await dealIdDoLead(),
      })
      return { success: true, executivo: andre.name }
    },
  })

  // ── registrar_pendencia_jdl ───────────────────────────────────────────────
  const registrar_pendencia_jdl = tool({
    description:
      'Jornada Online — SUPORTE. Abre pendência e avisa a equipe, que é acompanhada até ser resolvida. ' +
      'tipo="acesso": aluno não recebeu o e-mail de acesso ou não consegue entrar na plataforma (avisa Jéssica e Hugo). ' +
      'tipo="reembolso": pediu reembolso/cancelamento (avisa Jéssica e Maria Helena). ' +
      'Peça o e-mail da compra antes, se ainda não tiver; se o aluno não souber, registre mesmo assim.',
    parameters: z.object({
      tipo: z.enum(['acesso', 'reembolso']),
      nome: z.string().optional(),
      email_compra: z.string().optional(),
      descricao: z.string().optional().describe('O que o aluno relatou, em uma frase'),
    }),
    execute: async ({ tipo, nome, email_compra, descricao }) => {
      const r = await criarPendencia(pool, { phone, tipo, nome, email: email_compra, descricao })
      if (!r) return { success: false, message: 'Não consegui registrar agora.' }
      return {
        success: true,
        codigo: r.codigo,
        instrucao: tipo === 'acesso'
          ? 'Diga ao aluno que já avisou a equipe responsável pelo acesso e que vão verificar e retornar. Não prometa prazo.'
          : 'Diga que a garantia é de 7 dias, que já encaminhou a solicitação para a equipe e que vão retornar com o procedimento.',
      }
    },
  })

  return {
    registrar_funil,
    nao_contatar,
    consultar_horarios_andre,
    agendar_reuniao_andre,
    handoff_mentoria,
    registrar_pendencia_jdl,
  }
}
