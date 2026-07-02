/**
 * src/scripts/fix-marissol-andre.ts
 *
 * ONE-SHOT (remover após rodar): encaminha o lead Marissol Portela (GPS) pro
 * André pela via real (núcleo único encaminharLead) e avisa a Malu que o
 * encaminhamento pelo WhatsApp foi corrigido.
 *
 * Idempotente: se já existe mensagem enviada mencionando "Marissol", pula tudo.
 */

import type { Pool } from 'pg'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { normalizePhone } from '../uazapi/normalize-phone.js'
import { encaminharLead } from '../routing/encaminhar-lead.js'
import { env } from '../lib/env.js'

export async function runFixMarissolAndre(pool: Pool): Promise<void> {
  const log = logger.child({ context: 'oneshot-marissol' })
  try {
    // Idempotência: o lead já foi ENCAMINHADO PRA EQUIPE (não confundir com as
    // respostas de falha "não encontrei Marissol", que são categoria 'lead').
    const done = await pool.query(
      `SELECT 1 FROM rica_mensagens_enviadas
       WHERE conteudo ILIKE '%marissol%' AND categoria = 'equipe' LIMIT 1`,
    )
    if (done.rows.length > 0) {
      log.info('Marissol já encaminhada pra equipe — skip')
      return
    }

    // 1. Encaminha de verdade: avisa André + cópia gestora + registra + define dono
    const r = await encaminharLead({
      telefone: '11965869590',
      nome: 'Marissol Portela',
      produto: 'GPS',
      executivo: 'André',
      solicitante: 'Malu (correção Rica)',
    })
    log.info({ ok: r.success, exec: r.executiveName, err: r.errorMessage }, 'Encaminhamento Marissol→André')
    if (!r.success) {
      log.error({ err: r.errorMessage }, 'Encaminhamento falhou — não aviso a Malu')
      return
    }

    // 2. Avisa a Malu (resolve o WhatsApp dela pelo email no CRM)
    const malu = await pool.query<{ wa: string }>(
      `SELECT regexp_replace(whatsapp, '\\D', '', 'g') AS wa
       FROM users
       WHERE organization_id = $1 AND whatsapp IS NOT NULL AND lower(email) = lower($2)
       LIMIT 1`,
      [env.ORG_ID, 'malumktsucesso@gmail.com'],
    )
    const waMalu = malu.rows[0]?.wa
    if (!waMalu) {
      log.warn('WhatsApp da Malu não encontrado no CRM — lead foi encaminhado, mas não avisei ela')
      return
    }

    const msg =
      `Oi Malu! 👋\n\n` +
      `Sobre aquele lead que você tentou me passar (*Marissol Portela*, GPS): achei e corrigi o problema. ` +
      `Eu estava conseguindo só *consultar* leads pelo WhatsApp, mas não *encaminhar* — por isso eu ficava te pedindo o nome e não fazia nada. ✅\n\n` +
      `Agora consigo. Acabei de enviar a *Marissol* pro *André* e ele já foi notificado com os dados dela. 🎯\n\n` +
      `Pode mandar os próximos assim: *telefone + nome + pra quem encaminhar* (ou só o telefone e o produto que eu roteio pelo executivo certo). 🤖`
    await sendWhatsApp(normalizePhone(waMalu), msg)
    log.info({ wa: waMalu.slice(-4) }, 'Malu avisada')
  } catch (err) {
    log.error({ err }, 'one-shot Marissol falhou')
  }
}
