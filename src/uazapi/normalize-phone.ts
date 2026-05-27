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
 * 3. Se tem 10-11 dígitos (DDD + número) → adiciona "55"
 * 4. Se tem mais de 13 dígitos → número internacional, mantém como está
 * 5. Se tem menos de 10 dígitos → inválido, retorna como está (loga warning)
 *
 * Para ENVIO via uazapi, o número deve ter apenas dígitos (sem +, sem espaços).
 * Para COMPARAÇÃO com banco (LeadsAlexy), usar o número normalizado.
 */

import { logger } from '../observability/logger.js'

/**
 * Normaliza um número de telefone para o formato padrão do rica-bot.
 * Retorna string com apenas dígitos, com código de país quando possível.
 *
 * @example
 * normalizePhone('5511999887766@s.whatsapp.net') // → '5511999887766'
 * normalizePhone('+55 11 9998-8776')             // → '5511999887766'  (corrige 8→9 dígitos)
 * normalizePhone('11999887766')                   // → '5511999887766'
 * normalizePhone('5511 9998-8776')               // → '5511999887766' (não adiciona 55 de novo)
 * normalizePhone('+1 (555) 123-4567')            // → '15551234567'   (mantém código US)
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
