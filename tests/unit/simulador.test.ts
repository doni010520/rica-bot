/**
 * tests/unit/simulador.test.ts
 *
 * O simulador roda o agente REAL, com as tools reais no catálogo. Se o
 * interceptador falhar, `notificar_equipe` manda WhatsApp para um executivo de
 * verdade e `designar_lead` cria negócio no CRM — a partir de um botão de teste.
 * Por isso estes testes existem.
 */
import { describe, it, expect } from 'vitest'
import type { Pool } from 'pg'
import { tolsDeSimulacao, TELEFONE_SIMULADO, type ChamadaDeTool } from '../../src/agent/simulador.js'

// Pool que EXPLODE se alguém tentar usar: nenhuma tool pode tocar o banco aqui.
const poolProibido = {
  query: () => { throw new Error('o simulador não pode consultar o banco') },
  connect: () => { throw new Error('o simulador não pode abrir conexão') },
} as unknown as Pool

const montar = () => {
  const registro: ChamadaDeTool[] = []
  return { tools: tolsDeSimulacao(TELEFONE_SIMULADO, poolProibido, registro), registro }
}

const PERIGOSAS = ['notificar_equipe', 'designar_lead', 'notificar_andre', 'enviar_apresentacao']

describe('simulador — interceptação de tools', () => {
  it('o telefone simulado não é um número real (DDD 99 não existe)', () => {
    expect(TELEFONE_SIMULADO).toMatch(/^5599/)
  })

  it('expõe as mesmas tools do agente de produção', () => {
    const { tools } = montar()
    expect(Object.keys(tools).length).toBeGreaterThan(15)
    for (const nome of PERIGOSAS) expect(tools).toHaveProperty(nome)
  })

  it.each(PERIGOSAS)('%s NÃO executa de verdade e é registrada', async (nome) => {
    const { tools, registro } = montar()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (tools[nome] as any).execute({ teste: 'x' }, {})
    expect(r.simulado).toBe(true)
    expect(registro).toHaveLength(1)
    expect(registro[0]?.tool).toBe(nome)
    expect(registro[0]?.executada).toBe(false)
  })

  it('devolve sucesso para o modelo seguir a conversa', async () => {
    const { tools } = montar()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (tools['notificar_equipe'] as any).execute({}, {})
    expect(r.success).toBe(true)
    expect(String(r.message)).toContain('SIMULAÇÃO')
  })

  it('preserva description e parameters (o schema ensina o modelo a chamar)', () => {
    const { tools } = montar()
    for (const nome of PERIGOSAS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = tools[nome] as any
      expect(t.parameters).toBeDefined()
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  it('buscar_documentos continua sendo a ÚNICA que executa de verdade', async () => {
    const { tools, registro } = montar()
    // qualquer tool que não seja buscar_documentos deve sair como executada:false
    for (const nome of Object.keys(tools)) {
      if (nome === 'buscar_documentos') continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tools[nome] as any).execute({}, {})
    }
    expect(registro.every(c => c.executada === false)).toBe(true)
    expect(registro.length).toBe(Object.keys(tools).length - 1)
  })
})
