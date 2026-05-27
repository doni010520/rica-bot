/**
 * src/tools/index.ts
 *
 * Registro central de todas as tools da Rica.
 *
 * Sprint 2: 14 CRM + 4 operational = 18 tools
 * Sprint 3: + notificar_equipe, designar_lead = 20 tools
 * Sprint 5: + buscar_documentos, enviar_apresentacao, masterclass,
 *             processar_transcricao, notificar_andre = 25 tools
 */

import type { Pool } from 'pg'
import { buildCrmTools } from './crm/definitions.js'
import { buildOperationalTools } from './operations/definitions.js'
import { buildNotificarEquipeTool } from './operations/notificar-equipe.js'
import { buildDesignarLeadTool } from './operations/designar-lead.js'
import { buscar_documentos } from './rag/buscar-documentos.js'
import {
  enviar_apresentacao,
  masterclass,
  processar_transcricao,
  buildNotificarAndreTool,
} from './operations/extras.js'

export type AllTools = ReturnType<typeof buildAllTools>

export function buildAllTools(phone: string, pool: Pool) {
  return {
    ...buildCrmTools(phone),
    ...buildOperationalTools(phone, pool),
    notificar_equipe: buildNotificarEquipeTool(phone),
    designar_lead: buildDesignarLeadTool(phone),
    buscar_documentos,
    enviar_apresentacao,
    masterclass,
    processar_transcricao,
    notificar_andre: buildNotificarAndreTool(phone),
  }
}
