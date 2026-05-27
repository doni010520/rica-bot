/**
 * src/routing/region-mapper.ts
 *
 * Mapeamento DDD → região/subregião/estado.
 * Extraído do Code1 do notificar_equipe do n8n.
 */

export type Region = 'norte' | 'nordeste' | 'sudeste' | 'sul' | 'centro_oeste' | 'nao_identificada'
export type Subregion = 'sao_paulo' | 'rio_de_janeiro' | 'sudeste_outros' | Region

export type RegionInfo = {
  ddd: number | null
  region: Region
  subregion: Subregion
  state: string
}

const REGION_MAP: Record<Region, number[]> = {
  norte:        [68, 96, 92, 97, 91, 93, 94, 69, 95, 63],
  nordeste:     [82, 71, 73, 74, 75, 77, 85, 88, 98, 99, 83, 81, 87, 86, 89, 79, 84],
  sudeste:      [27, 28, 31, 32, 33, 34, 35, 37, 38, 21, 22, 24, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  sul:          [41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55],
  centro_oeste: [62, 64, 65, 66, 67, 61],
  nao_identificada: [],
}

const SP_DDDS = [11, 12, 13, 14, 15, 16, 17, 18, 19]
const RJ_DDDS = [21, 22, 24]
const ES_DDDS = [27, 28]
const MG_DDDS = [31, 32, 33, 34, 35, 37, 38]
const BA_DDDS = [71, 73, 74, 75, 77]
const PE_DDDS = [81, 87]

export function extractDDDFromPhone(phone: string): number | null {
  const digits = phone.replace(/\D/g, '')
  let clean = digits
  if (clean.startsWith('55') && clean.length >= 12) {
    clean = clean.slice(2)
  }
  if (clean.length < 10) return null
  const ddd = parseInt(clean.slice(0, 2), 10)
  return ddd >= 11 && ddd <= 99 ? ddd : null
}

export function mapDDDToRegion(phone: string): RegionInfo {
  const ddd = extractDDDFromPhone(phone)
  if (!ddd) return { ddd: null, region: 'nao_identificada', subregion: 'nao_identificada', state: '' }

  let region: Region = 'nao_identificada'
  for (const [key, ddds] of Object.entries(REGION_MAP) as [Region, number[]][]) {
    if (ddds.includes(ddd)) { region = key; break }
  }

  let subregion: Subregion = region
  let state = ''

  if (SP_DDDS.includes(ddd))       { subregion = 'sao_paulo';       state = 'SP' }
  else if (RJ_DDDS.includes(ddd))  { subregion = 'rio_de_janeiro';  state = 'RJ' }
  else if (ES_DDDS.includes(ddd))  { subregion = 'sudeste_outros';  state = 'ES' }
  else if (MG_DDDS.includes(ddd))  { subregion = 'sudeste_outros';  state = 'MG' }
  else if (BA_DDDS.includes(ddd))  { state = 'BA' }
  else if (PE_DDDS.includes(ddd))  { state = 'PE' }

  return { ddd, region, subregion, state }
}
