/**
 * src/scripts/broadcast-gps-andre.ts
 *
 * Envio ÚNICO (one-shot) pro André: os 32 leads de GPS da semana passada
 * (15-21/06), não qualificados. Roda no boot. Idempotente: checa o log de
 * mensagens (rica_mensagens_enviadas) por uma frase única e não reenvia.
 *
 * TEMPORÁRIO — remover após confirmar o envio.
 */

import { getPool } from '../lib/db.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { logger } from '../observability/logger.js'

const ANDRE_PHONE = '5511958430345'
const UNIQUE_PHRASE = 'GPS Padaria que chegaram na semana passada (15 a 21/06)'

const PHONES = [
  '553891992204', '553191365192', '553184266694', '553299611058', '553897287734',
  '5527999567052', '5521999631564', '553196114925', '5524999196113', '5521997584510',
  '5521983017909', '553284412264', '558192772716', '553197264700', '558194378348',
  '553171049119', '5522997409839', '558799061873', '558186062484', '553284844656',
  '553399991443', '5521986125992', '5521994699494', '5521976244994', '553588148942',
  '5521964951383', '5521997670713', '5524998641743', '553496921812', '553899175821',
  '553284386108', '5524992085478',
]

function buildMessage(): string {
  const links = PHONES.map((p) => `wa.me/${p}`).join('\n')
  return (
    `Oi, André! 👋\n\n` +
    `Te passando os ${PHONES.length} leads de ${UNIQUE_PHRASE}.\n\n` +
    `⚠️ Eles NÃO foram qualificados — chegaram pelo WhatsApp mas não avançaram na conversa. ` +
    `Já estão todos no seu funil GPS no CRM, marcados como "não qualificado". ` +
    `Vale dar uma olhada e ver quais valem o contato:\n\n` +
    links +
    `\n\n🤖 Rica`
  )
}

export async function broadcastGpsAndreOnce(): Promise<void> {
  const log = logger.child({ context: 'broadcast-gps-andre' })
  try {
    const pool = getPool()
    const already = await pool.query(
      `SELECT 1 FROM rica_mensagens_enviadas WHERE to_phone = $1 AND conteudo LIKE $2 LIMIT 1`,
      [ANDRE_PHONE, `%${UNIQUE_PHRASE}%`],
    )
    if (already.rows.length > 0) {
      log.info('Broadcast GPS→André já enviado anteriormente — skip')
      return
    }
    await sendWhatsApp(ANDRE_PHONE, buildMessage())
    log.info({ leads: PHONES.length }, '📤 Broadcast GPS→André enviado')
  } catch (err) {
    log.error({ err }, 'Falha no broadcast GPS→André')
  }
}
