/**
 * src/routing/gestao.ts
 *
 * Tudo que a Rica manda para a gestora (Maria Helena) vai também, em cópia, para
 * quem a ajuda a acompanhar. 13/10/2026, Jéssica: "Tudo que for enviado para a
 * Maria da Rica, pode habilitar para mim também. Porque ela precisa de ajuda".
 *
 * Cópia em env COPIA_GESTORA_PHONES (padrão: Jéssica). Falha na cópia nunca
 * derruba o envio principal.
 */

import { env } from '../lib/env.js'
import { logger } from '../observability/logger.js'
import { sendWhatsApp } from '../uazapi/client.js'
import { EXECUTIVES } from './executives.config.js'

type Opcoes = Parameters<typeof sendWhatsApp>[2]

/** Telefones que recebem cópia do que vai para a Maria (com DDI 55). */
export function copiasDaGestora(): string[] {
  return env.COPIA_GESTORA_PHONES.split(',').map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 12)
}

/** Manda a mesma mensagem, só como cópia, para quem acompanha a gestora. */
export async function copiarParaGestao(texto: string): Promise<void> {
  for (const phone of copiasDaGestora()) {
    await sendWhatsApp(phone, texto, { crmSender: null }).catch((err) =>
      logger.warn({ err, phone: phone.slice(-4) }, 'Cópia para a gestão falhou'),
    )
  }
}

/** Envia para a Maria (mesmas opções de antes) e copia para a gestão. */
export async function enviarParaGestora(texto: string, opts?: Opcoes): Promise<void> {
  await sendWhatsApp(EXECUTIVES.MARIA_HELENA.phoneFormatted, texto, opts)
  await copiarParaGestao(texto)
}
