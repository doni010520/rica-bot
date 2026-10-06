/**
 * src/agent/prompt.ts
 *
 * Carrega e monta o system prompt da Rica.
 * Tenta arquivos modulares (00-*.md), fallback para monolito (rica-principal.md).
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nowFormatted } from '../lib/timezone.js'
import { logger } from '../observability/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = join(__dirname, '../../prompts')

export type CrmContext = {
  exists: boolean
  contactId?: string | undefined
  contactName?: string | undefined
  companyId?: string | undefined
  companyName?: string | undefined
  dealId?: string | undefined
  openDeals?: string | undefined
  /** Bloco <funil_do_lead> (campanha/etapa/diagnóstico já coletado). */
  funil?: string | undefined
  phone: string
}

export function buildSystemPrompt(
  crm: CrmContext,
  phone: string,
  displayName: string,
): string {
  const modularFiles = getModularFiles()
  const parts: string[] = []

  if (modularFiles.length > 0) {
    for (const file of modularFiles) {
      const content = readPromptFile(file)
      if (content) parts.push(content)
    }
  } else {
    const monolith = readPromptFile('rica-principal.md')
    if (monolith) {
      parts.push(monolith)
    } else {
      logger.warn('Nenhum prompt encontrado — usando prompt mínimo')
      parts.push(MINIMAL_PROMPT)
    }
  }

  let prompt = parts.join('\n\n')
  return injectVariables(prompt, crm, phone, displayName)
}

/**
 * CACHE DE PROMPT DA OPENAI (06/10/2026): o cache só reaproveita o PREFIXO
 * idêntico entre chamadas (a partir de ~1024 tokens). O bloco do CRM ficava no
 * token ~165 e a data com segundos no ~525, então cada chamada pagava os ~28 mil
 * tokens do prompt a preço cheio (12% de cache em set/out, contra 82% no Corrêa).
 *
 * Por isso o prompt sai em duas partes: o texto FIXO de rica-principal.md, igual
 * byte a byte em toda chamada, e no FIM o <contexto_da_conversa> com tudo que muda
 * (data/hora, telefone, nome, CRM e funil). No lugar antigo do bloco do CRM fica
 * só uma frase fixa apontando para o fim. Não coloque valor variável no meio do
 * template: qualquer {{...}} substituído ali volta a quebrar o cache.
 */
const CRM_NO_FIM =
  '(Os dados pré-carregados do CRM desta conversa, no bloco <crm_pre_carregado>, estão no fim deste prompt, dentro de <contexto_da_conversa>.)'

function injectVariables(
  template: string,
  crm: CrmContext,
  phone: string,
  displayName: string,
): string {
  const fixo = template.replace(/<crm_pre_carregado>[\s\S]*?<\/crm_pre_carregado>/g, CRM_NO_FIM)

  const contexto = [
    '<contexto_da_conversa>',
    `Hoje é: ${nowFormatted()}`,
    `Telefone do usuário: ${phone}`,
    `Nome no WhatsApp: ${displayName}`,
    '',
    buildCrmBlock(crm),
    '</contexto_da_conversa>',
  ].join('\n')

  return `${fixo}\n\n${contexto}`
}

function buildCrmBlock(crm: CrmContext): string {
  return `<crm_pre_carregado>
    DADOS DO CRM JA CARREGADOS PELO SISTEMA:

    CONTATO_EXISTE: ${crm.exists}
    CONTACT_ID: ${crm.contactId ?? ''}
    CONTACT_NAME: ${crm.contactName || '(desconhecido)'}
    COMPANY_ID: ${crm.companyId ?? ''}
    COMPANY_NAME: ${crm.companyName ?? ''}
    DEAL_ID: ${crm.dealId ?? ''}
    DEALS_ABERTOS: ${crm.openDeals ?? '[]'}

    REGRA DE OURO: No PRIMEIRO turno, Rica usa os dados acima
    e responde ao cliente imediatamente.
    REGRA DO NOME: Se CONTACT_NAME estiver vazio ou "(desconhecido)", NUNCA
    use o número de telefone como nome. Cumprimente SEM nome (ex: "Oi! 😊")
    e, com naturalidade, pergunte como pode chamar a pessoa — EXCETO nas
    campanhas Mentoria, Jornada e GPS: lá o nome só é pedido depois do diagnóstico.
</crm_pre_carregado>${crm.funil ? `
${crm.funil}` : ''}`
}

function readPromptFile(filename: string): string | null {
  const path = join(PROMPTS_DIR, filename)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf-8').trim()
  } catch {
    logger.warn({ path }, 'Erro ao ler arquivo de prompt')
    return null
  }
}

function getModularFiles(): string[] {
  if (!existsSync(PROMPTS_DIR)) return []
  try {
    return readdirSync(PROMPTS_DIR)
      .filter((f) => /^\d{2}-/.test(f) && f.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
}

const MINIMAL_PROMPT = `Você é Rica, assistente virtual da Sucesso no Resultado.
Responda em português de forma amigável e profissional.
Data/hora atual: {{DATA_HORA}}
Telefone do usuário: {{TELEFONE}}`
