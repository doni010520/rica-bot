/**
 * src/routing/executives.config.ts
 *
 * Fonte de verdade dos executivos da Sucesso no Resultado.
 * Extraída do Code2 (notificar_equipe) e "Identificar Executivo" (designar_lead).
 *
 * Telefones e emails vêm de env vars (EXEC_*_PHONE, EXEC_*_EMAIL) — não ficam
 * hardcoded no repo. Configurar no EasyPanel.
 *
 * As env vars de telefone devem conter os dígitos COM o DDI 55 (formato uazapi).
 * Ex: EXEC_ANDRE_PHONE=5511958430345
 */

import { env } from '../lib/env.js'

export type Executive = {
  name: string
  email: string
  phone: string           // apenas dígitos, sem 55
  phoneFormatted: string  // com 55 para uazapi
}

function exec(name: string, email: string, phoneFormatted: string): Executive {
  return {
    name,
    email,
    phone: phoneFormatted.replace(/^55/, ''),
    phoneFormatted,
  }
}

export const EXECUTIVES = {
  ANDRE: exec('André Augusto', env.EXEC_ANDRE_EMAIL, env.EXEC_ANDRE_PHONE),
  ALEX: exec('Alex Araújo', env.EXEC_ALEX_EMAIL, env.EXEC_ALEX_PHONE),
  GABRIELA: exec('Gabriela Câmara', env.EXEC_GABRIELA_EMAIL, env.EXEC_GABRIELA_PHONE),
  LUCIA: exec('Lúcia Carcerere', env.EXEC_LUCIA_EMAIL, env.EXEC_LUCIA_PHONE),
  CAROLINA: exec('Carolina Câmara', env.EXEC_CAROLINA_EMAIL, env.EXEC_CAROLINA_PHONE),
  HELEN: exec('Helen Monte', env.EXEC_HELEN_EMAIL, env.EXEC_HELEN_PHONE),
  MARIA_HELENA: exec('Maria Helena', env.EXEC_MARIA_HELENA_EMAIL, env.EXEC_MARIA_HELENA_PHONE),
  IRELENE: exec('Irelene Guerreiro', env.EXEC_IRELENE_EMAIL, env.EXEC_IRELENE_PHONE),
  ANA_CLARA: exec('Ana Clara', env.EXEC_ANA_CLARA_EMAIL, env.EXEC_ANA_CLARA_PHONE),
  VANESSA: exec('Vanessa Souza', env.EXEC_VANESSA_EMAIL, env.EXEC_VANESSA_PHONE),
  PATRICIA: exec('Patrícia Alves', env.EXEC_PATRICIA_EMAIL, env.EXEC_PATRICIA_PHONE),
} as const

export type ExecutiveKey = keyof typeof EXECUTIVES

export const EXECUTIVE_ALIASES: Record<string, ExecutiveKey> = {
  'helen': 'HELEN',
  'helen monte': 'HELEN',
  'maria helena': 'MARIA_HELENA',
  'maria': 'MARIA_HELENA',
  'andre': 'ANDRE',
  'andré': 'ANDRE',
  'andre augusto': 'ANDRE',
  'andré augusto': 'ANDRE',
  'alex': 'ALEX',
  'alex araujo': 'ALEX',
  'alex araújo': 'ALEX',
  'gabriela': 'GABRIELA',
  'gabriela camara': 'GABRIELA',
  'gabriela câmara': 'GABRIELA',
  'lucia': 'LUCIA',
  'lúcia': 'LUCIA',
  'lucia carcerere': 'LUCIA',
  'lúcia carcerere': 'LUCIA',
  'carolina': 'CAROLINA',
  'carolina camara': 'CAROLINA',
  'carolina câmara': 'CAROLINA',
  'irelene': 'IRELENE',
  'irelene guerreiro': 'IRELENE',
  'ana clara': 'ANA_CLARA',
  'vanessa': 'VANESSA',
  'vanessa souza': 'VANESSA',
  'patricia': 'PATRICIA',
  'patrícia': 'PATRICIA',
  'patricia alves': 'PATRICIA',
  'patrícia alves': 'PATRICIA',
}

/**
 * Resolve um executivo a partir de um nome livre ("André", "patrícia alves",
 * "Lúcia C."). Tenta o nome completo normalizado e, em fallback, só o 1º nome.
 * Retorna null se não reconhecer.
 */
export function resolveExecutiveByName(name: string): Executive | null {
  if (!name) return null
  const norm = name.trim().toLowerCase()
  const key = EXECUTIVE_ALIASES[norm] ?? EXECUTIVE_ALIASES[norm.split(/\s+/)[0] ?? '']
  return key ? EXECUTIVES[key] : null
}

// ─── rede de segurança: executivo NUNCA é lead ───────────────────────────────

/** Chave tolerante ao 9º dígito: DDD + últimos 8 dígitos. */
function phoneKey(phone: string): string {
  const d = (phone ?? '').replace(/\D/g, '')
  if (d.length < 10) return ''
  const ddd = d.length >= 12 ? d.slice(2, 4) : d.slice(0, 2)
  return `${ddd}${d.slice(-8)}`
}

const EXEC_PHONE_KEYS = new Set(
  Object.values(EXECUTIVES)
    .map((e) => phoneKey(e.phoneFormatted))
    .filter(Boolean),
)

/**
 * O telefone é de um executivo do time?
 *
 * REDE DE SEGURANÇA: o copiloto só reconhece o time se o CRM tiver o número em
 * `users.whatsapp` — e vários executivos não estão cadastrados lá. Sem esta
 * checagem, o executivo cai no fluxo de LEAD: vira deal no pipeline, a Rica
 * tenta vender pra ele e o follow-up passa a cobrá-lo. Aqui o rica-bot usa a
 * PRÓPRIA config (EXEC_*_PHONE) e não depende da allowlist do CRM estar certa.
 */
export function isKnownExecutive(phone: string): boolean {
  const k = phoneKey(phone)
  return k !== '' && EXEC_PHONE_KEYS.has(k)
}
