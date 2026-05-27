/**
 * src/lib/timezone.ts
 *
 * Funções de data/hora com timezone explícito (America/Sao_Paulo).
 *
 * CONTEXTO: Um dos bugs documentados do n8n era o uso de UTC em vez de BRT,
 * causando horários errados nas mensagens e no CRM. Este módulo é a fonte
 * única de verdade para qualquer formatação de data no rica-bot.
 *
 * Usamos a API nativa Intl (Node 22 tem suporte completo a temporal API)
 * sem dependências externas para manter o bundle leve.
 */

const TZ = 'America/Sao_Paulo'

// ─── tipos ──────────────────────────────────────────────────────────────────

export type BrasiliaDate = {
  date: Date
  /** ISO string com offset BRT: "2026-05-22T14:30:00.000-03:00" */
  iso: string
  /** Timestamp Unix em ms */
  ts: number
  /** Formatado longo: "sexta-feira, 22 de maio de 2026 às 14:30:00 BRT" */
  long: string
  /** Formatado curto: "22/05/2026 14:30" */
  short: string
  /** Só a hora: "14:30" */
  time: string
  /** Só a data: "22/05/2026" */
  dateStr: string
}

// ─── funções principais ─────────────────────────────────────────────────────

/**
 * Retorna o momento atual no fuso America/Sao_Paulo.
 *
 * @example
 * const now = nowBrasilia()
 * console.log(now.long)  // "sexta-feira, 22 de maio de 2026 às 14:30:00 BRT"
 * console.log(now.short) // "22/05/2026 14:30"
 */
export function nowBrasilia(): BrasiliaDate {
  return toBrasilia(new Date())
}

/**
 * Converte qualquer Date para um objeto BrasiliaDate com todas as formatações.
 */
export function toBrasilia(date: Date): BrasiliaDate {
  const fmtLong = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })

  const fmtShort = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  const fmtTime = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  })

  const fmtDate = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  // ISO com offset BRT (-03:00)
  const iso = toISOWithOffset(date, TZ)

  return {
    date,
    iso,
    ts: date.getTime(),
    long: fmtLong.format(date),
    short: fmtShort.format(date),
    time: fmtTime.format(date),
    dateStr: fmtDate.format(date),
  }
}

/**
 * Retorna o timestamp atual no sistema de Brasília como string ISO.
 * Atalho para quando só precisa do ISO.
 */
export function nowISO(): string {
  return nowBrasilia().iso
}

/**
 * Retorna a data atual formatada longa (equivalente ao $now.setZone do n8n).
 *
 * Equivalente ao n8n: `$now.setZone("America/Sao_Paulo").toFormat("FFFF")`
 */
export function nowFormatted(): string {
  return nowBrasilia().long
}

/**
 * Verifica se um horário está dentro do horário comercial de Brasília.
 * Usado no worker de follow-up para garantir envios apenas em horário útil.
 *
 * @param date - Data a verificar (default: agora)
 * @param startHour - Início do período (default: 9)
 * @param endHour - Fim do período (default: 18)
 */
export function isBusinessHour(date: Date = new Date(), startHour = 9, endHour = 18): boolean {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date)

  const hourPart = parts.find((p) => p.type === 'hour')
  const weekdayPart = parts.find((p) => p.type === 'weekday')

  if (!hourPart || !weekdayPart) return false

  const hour = parseInt(hourPart.value, 10)
  const weekday = weekdayPart.value.toLowerCase()

  // Fins de semana (sáb, dom)
  if (weekday.startsWith('sáb') || weekday.startsWith('dom')) return false

  return hour >= startHour && hour < endHour
}

/**
 * Delay em ms. Atalho pra usar em loops de chunking.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── helper interno ─────────────────────────────────────────────────────────

/**
 * Produz um ISO 8601 com o offset correto do timezone informado.
 * Node 22 não tem Temporal API estável ainda, então calculamos via Intl.
 */
function toISOWithOffset(date: Date, tz: string): string {
  // Obtém as partes da data no timezone alvo
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3,
  })

  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]))

  // Calcula o offset em minutos comparando UTC com o tz local
  const utcMs = date.getTime()
  const localMs = new Date(
    `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}`,
  ).getTime()
  const offsetMin = Math.round((localMs - utcMs) / 60000)

  const sign = offsetMin >= 0 ? '+' : '-'
  const absMin = Math.abs(offsetMin)
  const offsetHH = String(Math.floor(absMin / 60)).padStart(2, '0')
  const offsetMM = String(absMin % 60).padStart(2, '0')

  const ms = String(date.getMilliseconds()).padStart(3, '0')

  return (
    `${parts['year']}-${parts['month']}-${parts['day']}` +
    `T${parts['hour']}:${parts['minute']}:${parts['second']}.${ms}` +
    `${sign}${offsetHH}:${offsetMM}`
  )
}
