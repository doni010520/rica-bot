/**
 * Quem pediu para parar, recusou ou procura emprego sai da régua como PERDIDO
 * (13/10/2026: Solange e Clenilda seguiam recebendo follow-up).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const atualizarFunil = vi.fn()
vi.mock('../../src/funil/funil.js', () => ({ atualizarFunil: (...a: unknown[]) => atualizarFunil(...a) }))
const notifyHR = vi.fn(async () => true)
vi.mock('../../src/candidato/detect.js', () => ({ notifyHR: (...a: unknown[]) => notifyHR(...a) }))
const alertarPerdido = vi.fn()
vi.mock('../../src/alertas/alertas.js', () => ({ alertarPerdido: (...a: unknown[]) => alertarPerdido(...a) }))

const { encerrarComoPerdido, ehBuscaDeEmprego, temSinalDeSaida, ricaPrometeuParar } = await import('../../src/qualificacao/encerrar-lead.js')

const sqls: string[] = []
const pool = { query: vi.fn(async (sql: string) => { sqls.push(sql); return { rowCount: 1, rows: [] } }) }

describe('encerrar lead como perdido', () => {
  beforeEach(() => { sqls.length = 0; notifyHR.mockClear(); atualizarFunil.mockClear(); alertarPerdido.mockClear() })

  it('pediu para parar: não contatar, deal perdido, alerta — sem e-mail do RH', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await encerrarComoPerdido(pool as any, '553899433697', 'pediu para não ser mais contatada', 'mentoria', 'não liga pra mim mais não')
    expect(atualizarFunil).toHaveBeenCalledWith(pool, '553899433697', 'mentoria', expect.objectContaining({ etapa: 'nao_contatar' }))
    expect(sqls.some((s) => /nao_contatar = true/.test(s))).toBe(true)
    expect(sqls.some((s) => /UPDATE deals SET status = 'lost'/.test(s))).toBe(true)
    expect(notifyHR).not.toHaveBeenCalled()
    expect(alertarPerdido).toHaveBeenCalledWith('553899433697', 'pediu para não ser mais contatada')
  })

  it('procura emprego: também recebe o e-mail do RH', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await encerrarComoPerdido(pool as any, '5511990182036', 'A pessoa procura vaga de ajudante de padaria', 'mentoria', 'ayudante de panadería')
    expect(notifyHR).toHaveBeenCalledWith(expect.objectContaining({ candidatePhone: '5511990182036' }))
  })

  it('reconhece motivo de emprego', () => {
    expect(ehBuscaDeEmprego('procura vaga de padeiro')).toBe(true)
    expect(ehBuscaDeEmprego('quer trabalhar na padaria')).toBe(true)
    expect(ehBuscaDeEmprego('disse que não quer agora')).toBe(false)
  })

  it('filtro sem IA: recusas e emprego acionam; adiar e conversa normal não', () => {
    for (const t of ['Não, obrigado', 'Deixa pra outra oportunidade, não vou querer agora', 'não liga pra mim mais não, senão eu vou na polícia',
      'eu não vou precisar de você pra nada', 'Si estoy interesado en alludante de panadería', 'Preciso de trabalho na padaria', 'para de me mandar mensagem'])
      expect(temSinalDeSaida(t), t).toBe(true)
    for (const t of ['Mas tarde, estou fazendo compras', 'Melhorar o lucro', 'Quero saber como funciona e quanto custa', 'Oi, quero saber mais sobre a GPS Padaria'])
      expect(temSinalDeSaida(t), t).toBe(false)
  })

  it('reconhece quando a Rica prometeu parar de mandar mensagem', () => {
    expect(ricaPrometeuParar('Entendo, Solange. Vou respeitar seu pedido e não vou mais te enviar mensagens.')).toBe(true)
    expect(ricaPrometeuParar('Se precisar, é só chamar!')).toBe(false)
  })
})
