import { describe, it, expect } from 'vitest'
import { mensagemResgateGps, ajustarParaJanelaDoDia } from '../../src/followup/lead-followup.js'
import { montarBriefingGps, montarAvisoRemarcacao, dataHoraRecife } from '../../src/funil/handoff.js'
import { ETAPAS_POS_HANDOFF } from '../../src/funil/funil.js'

/** Manual "RICA + GPS — Programação Comercial e Cadência de Conversão" (set/2026). */

const recife = (iso: string) => new Date(`${iso}-03:00`)

describe('cadência de resgate do GPS (seção 14)', () => {
  it('usa os textos do manual com o primeiro nome', () => {
    expect(mensagemResgateGps(1, 'Carla Souza')).toBe(
      'Oi, Carla 😊 Fiquei curiosa com uma coisa: você chegou até a GPS por algum motivo. O que você gostaria de melhorar hoje na sua padaria que fez você parar naquele anúncio?',
    )
    expect(mensagemResgateGps(3, 'Carla')).toMatch(/^Carla, uma das vantagens da GPS/)
    expect(mensagemResgateGps(5, 'Carla')).toContain('é só mandar “GPS” aqui')
  })

  it('sem nome não inventa vocativo (nem usa telefone como nome)', () => {
    expect(mensagemResgateGps(1, null)).toMatch(/^Oi 😊/)
    expect(mensagemResgateGps(3, '5581999887766')).toMatch(/^Uma das vantagens/)
    expect(mensagemResgateGps(4, '')).toMatch(/^Posso te fazer uma pergunta rápida\?/)
  })

  it('resgate 2 cumprimenta conforme a hora', () => {
    expect(mensagemResgateGps(2, 'Ana', recife('2026-09-30T09:00:00'))).toMatch(/^Bom dia, Ana!/)
    expect(mensagemResgateGps(2, 'Ana', recife('2026-09-30T15:00:00'))).toMatch(/^Boa tarde, Ana!/)
  })

  it('toque só sai entre 8h e 20h de Recife', () => {
    const agora = recife('2026-09-30T19:00:00').getTime()
    // +3h cairia 22h → vai para 8h do dia seguinte
    const d = ajustarParaJanelaDoDia(3 * 3_600_000, agora)
    expect(new Date(agora + d).toISOString()).toBe(recife('2026-10-01T08:00:00').toISOString())
    // +3h às 10h → 13h, fica como está
    const manha = recife('2026-09-30T10:00:00').getTime()
    expect(ajustarParaJanelaDoDia(3 * 3_600_000, manha)).toBe(3 * 3_600_000)
    // madrugada → 8h do mesmo dia
    const noite = recife('2026-09-30T23:00:00').getTime()
    expect(new Date(noite + ajustarParaJanelaDoDia(3 * 3_600_000, noite)).toISOString()).toBe(recife('2026-10-01T08:00:00').toISOString())
  })
})

describe('briefing ao André (seções 10 e 11)', () => {
  const inicioIso = recife('2026-10-01T14:30:00').toISOString()
  const ficha = {
    produto: 'GPS Padaria',
    nome: 'Carla Souza',
    padaria: 'Pão Dourado',
    cidade: 'Recife',
    papel: 'dono',
    origem: 'Anúncio - GPS Padaria',
    interesse_do_anuncio: 'desenvolver a equipe',
    dor_principal: 'o time não segue os processos',
    categoria_dor: 'Equipe',
    classe: 'A',
  }

  it('traz os campos, a data/hora e a ação do André', () => {
    const t = montarBriefingGps('5581999887766', ficha, { tipo: 'agendada', rotulo: '', inicioIso, eventId: 'ev1' })
    expect(t).toContain('🔔 *NOVO AGENDAMENTO GPS*')
    expect(t).toContain('Nome: Carla Souza')
    expect(t).toContain('WhatsApp: 5581999887766')
    expect(t).toContain('Empresa/Padaria: Pão Dourado')
    expect(t).toContain('Principal dor: o time não segue os processos (Equipe)')
    expect(t).toContain('📅 Reunião: 01/10')
    expect(t).toContain('⏰ Horário: 14:30')
    expect(t).toContain('*AÇÃO DO ANDRÉ:* entrar em contato com o cliente assim que receber esta mensagem')
  })

  it('traz o script do André preenchido', () => {
    const t = montarBriefingGps('5581999887766', ficha, { tipo: 'agendada', rotulo: '', inicioIso, eventId: 'ev1' })
    expect(t).toContain('Oi, Carla! Tudo bem? Aqui é André, da Sucesso na Padaria.')
    expect(t).toContain('você está buscando o time não segue os processos')
    expect(t).toContain('Nossa conversa ficou para 01/10, às 14:30. Está confirmado para você?')
  })

  it('sem reunião marcada, pede para o André chamar e combinar', () => {
    const t = montarBriefingGps('5581999887766', ficha, { tipo: 'sem_horario' })
    expect(t).toContain('🔔 *NOVO LEAD GPS PRA VOCÊ*')
    expect(t).toContain('combinar o horário')
    expect(t).not.toContain('Mensagem sugerida')
  })

  it('remarcação avisa o novo horário', () => {
    expect(montarAvisoRemarcacao('5581999887766', 'Carla', inicioIso)).toContain('📅 01/10 · ⏰ 14:30')
  })

  it('data/hora em Recife', () => {
    expect(dataHoraRecife(inicioIso)).toEqual({ data: '01/10', hora: '14:30' })
  })
})

describe('Rica fora da conversa depois do handoff (seção 12)', () => {
  it('agendado, transferido e os status do André silenciam a Rica; nutrição não', () => {
    for (const e of ['reuniao_agendada', 'transferido', 'confirmado_andre', 'no_show', 'remarcado', 'vendido']) {
      expect(ETAPAS_POS_HANDOFF.has(e)).toBe(true)
    }
    expect(ETAPAS_POS_HANDOFF.has('nutricao')).toBe(false)
    expect(ETAPAS_POS_HANDOFF.has('link_agenda_enviado')).toBe(false)
  })
})

import { blocoFunilParaPrompt, type FunilRow } from '../../src/funil/funil.js'

describe('primeira resposta ao lead do anúncio', () => {
  const base = { nome: null, padaria: null, interesse_do_anuncio: null, dor_principal: null } as unknown as FunilRow
  it('Jornada em etapa novo recebe a ordem de ABERTURA, não a apresentação', () => {
    const b = blocoFunilParaPrompt({ ...base, campanha: 'jdl', etapa: 'novo' } as FunilRow)
    expect(b).toContain('PRIMEIRA RESPOSTA')
    expect(b).toContain('NÃO mande a APRESENTAÇÃO')
  })
  it('GPS em etapa novo recebe a ENTRADA DO LEAD', () => {
    expect(blocoFunilParaPrompt({ ...base, campanha: 'gps', etapa: 'novo' } as FunilRow)).toContain('ENTRADA DO LEAD')
  })
  it('depois da primeira resposta a ordem some', () => {
    expect(blocoFunilParaPrompt({ ...base, campanha: 'jdl', etapa: 'engajou' } as FunilRow)).not.toContain('PRIMEIRA RESPOSTA')
  })
})
