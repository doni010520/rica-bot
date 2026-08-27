/**
 * src/uazapi/normalize-phone.ts
 *
 * Normalização de telefone — causa-raiz de bugs documentados no n8n.
 *
 * Bugs históricos resolvidos aqui:
 * - Cliente dos EUA recebia link com "55" indevido (número já tinha código internacional)
 * - Executivos com 8 dígitos no doc original (faltava o "9" no celular)
 * - Swap de números entre dois executivos cujos números haviam sido invertidos
 *
 * Regras implementadas:
 * 1. Remove tudo que não for dígito
 * 2. Se já começa com "55" e tem 12-13 dígitos → mantém
 * 3. Se tem 11 dígitos no formato NANP (EUA/Canadá) → mantém (ver isNanpNumber)
 * 4. Se tem 10-11 dígitos (DDD + número) → adiciona "55"
 * 5. Se tem mais de 13 dígitos → número internacional, mantém como está
 * 6. Se tem menos de 10 dígitos → inválido, retorna como está (loga warning)
 *
 * Para ENVIO via uazapi, o número deve ter apenas dígitos (sem +, sem espaços).
 * Para COMPARAÇÃO com banco (LeadsAlexy), usar o número normalizado.
 */

import { logger } from '../observability/logger.js'

/**
 * Detecta número do NANP (EUA/Canadá) no formato "1" + 10 dígitos.
 *
 * NANP: o código de área (NPA) e o prefixo (NXX) começam obrigatoriamente com
 * 2-9. Ex.: +1 (415) 555-1234 → 14155551234.
 *
 * O conflito com o Brasil é só aparente: número BR de 11 dígitos é sempre
 * celular, ou seja, DDD (11-99) + "9" + 8 dígitos. DDD 11 já cai fora do NANP
 * (NPA começaria com "1"); DDD 12-19 passaria no teste de NPA, mas nesses casos
 * o 3º dígito é sempre o "9" do celular. Por isso, se o 3º dígito for "9",
 * tratamos como brasileiro — na dúvida, o caso dominante ganha.
 */
function isNanpNumber(digits: string): boolean {
  if (digits.length !== 11 || !digits.startsWith('1')) return false
  // "1" + DDD 12-19 + celular BR (9 + 8 dígitos) → é brasileiro, não NANP.
  if (digits[2] === '9') return false
  const npaFirst = digits[1] ?? ''
  const nxxFirst = digits[4] ?? ''
  return /^[2-9]$/.test(npaFirst) && /^[2-9]$/.test(nxxFirst)
}

/**
 * Normaliza um número de telefone para o formato padrão do rica-bot.
 * Retorna string com apenas dígitos, com código de país quando possível.
 *
 * @example
 * normalizePhone('5511999887766@s.whatsapp.net') // → '5511999887766'
 * normalizePhone('+55 11 9998-8776')             // → '5511999887766'  (corrige 8→9 dígitos)
 * normalizePhone('11999887766')                   // → '5511999887766'
 * normalizePhone('5511 9998-8776')               // → '5511999887766' (não adiciona 55 de novo)
 * normalizePhone('+1 (415) 555-1234')            // → '14155551234'   (mantém código US/NANP)
 */
export function normalizePhone(raw: string): string {
  // Remove @s.whatsapp.net e qualquer sufixo @
  const withoutSuffix = raw.replace(/@.*/, '')

  // Só dígitos
  const digits = withoutSuffix.replace(/\D/g, '')

  if (digits.length === 0) {
    logger.warn({ raw }, 'normalizePhone: número sem dígitos')
    return raw
  }

  // Já tem código de país (começa com 55, 12-13 dígitos → Brasil)
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    return digits
  }

  // Número dos EUA/Canadá com código de país ("1" + 10 dígitos).
  // Bug histórico: caía na regra de 11 dígitos e virava 55 + 1... (link errado).
  if (isNanpNumber(digits)) {
    return digits
  }

  // Número brasileiro sem código de país (10-11 dígitos: DDD + número)
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`
  }

  // Número internacional já com código (>= 12 dígitos, não começa com 55)
  // Ex: +1 (555) 123-4567 → 15551234567
  if (digits.length >= 12) {
    return digits
  }

  // Menos de 10 dígitos — possivelmente incompleto
  logger.warn({ raw, digits, length: digits.length }, 'normalizePhone: número curto demais')
  return digits
}

/**
 * Formata número para envio via uazapi.
 * Remove qualquer formatação — uazapi quer só dígitos.
 *
 * @example
 * formatPhoneForSend('55119988-7766') // → '5511999887766'
 */
export function formatPhoneForSend(phone: string): string {
  return normalizePhone(phone)
}

/**
 * Verifica se dois números de telefone são equivalentes,
 * normalizando ambos antes de comparar.
 *
 * @example
 * phonesMatch('5511999887766', '11999887766')  // → true
 * phonesMatch('5511999887766', '5521999887766') // → false
 */
export function phonesMatch(a: string, b: string): boolean {
  return normalizePhone(a) === normalizePhone(b)
}

/**
 * Extrai DDD (código de área) de um número brasileiro normalizado.
 * Retorna null se não conseguir extrair.
 *
 * @example
 * extractDDD('5511999887766') // → '11'
 * extractDDD('5581988877766') // → '81'
 */
export function extractDDD(phone: string): string | null {
  const normalized = normalizePhone(phone)
  // Brasil: 55 + DDD (2 dígitos) + número (8 ou 9 dígitos)
  if (normalized.startsWith('55') && normalized.length >= 12) {
    return normalized.slice(2, 4)
  }
  return null
}
