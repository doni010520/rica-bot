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

function injectVariables(
  template: string,
  crm: CrmContext,
  phone: string,
  displayName: string,
): string {
  const now = nowFormatted()
  const crmBlock = buildCrmBlock(crm)

  return template
    .replace(/\{\{\s*\$now[^}]*\}\}/g, now)
    .replace(/{{DATA_HORA}}/g, now)
    .replace(/\{\{\s*\$\([^)]+\).*?telefone.*?\}\}/g, phone)
    .replace(/{{TELEFONE}}/g, phone)
    .replace(/\{\{\s*\$\([^)]+\).*?nome.*?\}\}/g, displayName)
    .replace(/{{NOME}}/g, displayName)
    .replace(/<crm_pre_carregado>[\s\S]*?<\/crm_pre_carregado>/g, crmBlock)
    .replace(/{{CRM_PRE_CARREGADO}}/g, crmBlock)
    .replace(/{{CRM_EXISTS}}/g, String(crm.exists))
    .replace(/{{CONTACT_ID}}/g, crm.contactId ?? '')
    .replace(/{{CONTACT_NAME}}/g, crm.contactName ?? displayName)
    .replace(/{{COMPANY_ID}}/g, crm.companyId ?? '')
    .replace(/{{COMPANY_NAME}}/g, crm.companyName ?? '')
    .replace(/{{DEAL_ID}}/g, crm.dealId ?? '')
    .replace(/{{DEALS_ABERTOS}}/g, crm.openDeals ?? '[]')
}

function buildCrmBlock(crm: CrmContext): string {
  return `<crm_pre_carregado>
    DADOS DO CRM JA CARREGADOS PELO SISTEMA:

    CONTATO_EXISTE: ${crm.exists}
    CONTACT_ID: ${crm.contactId ?? ''}
    CONTACT_NAME: ${crm.contactName ?? ''}
    COMPANY_ID: ${crm.companyId ?? ''}
    COMPANY_NAME: ${crm.companyName ?? ''}
    DEAL_ID: ${crm.dealId ?? ''}
    DEALS_ABERTOS: ${crm.openDeals ?? '[]'}

    REGRA DE OURO: No PRIMEIRO turno, Rica usa os dados acima
    e responde ao cliente imediatamente.
</crm_pre_carregado>`
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
