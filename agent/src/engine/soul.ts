// Soul-sheet loader — validates with the SAME shared module the app's editor
// uses (shared/soul-sheet/), so a sheet that exports cleanly from the app is
// guaranteed to load here. The TS type below mirrors schema.json by hand for
// now; if the two ever drift, schema.json wins (it is the source of truth,
// spec §5) — a future non-JS agent generates its types from that file.
import { readFileSync } from 'node:fs'
import { parseSoulSheet } from '../../../shared/soul-sheet/validate.js'

export type PillarName = 'photo drop' | 'gym take' | 'daily-life texture' | 'trend opinion'

export interface ContentPillar {
  name: PillarName
  weight: number
  media: 'always' | 'sometimes' | 'rarely' | 'never'
  queueGated?: boolean
}

export interface SoulSheet {
  schemaVersion: 1
  personaId: string
  ownerId: string
  identity: {
    name: string
    age?: number
    city?: string
    occupation?: string
    backstory?: string
    timezone: string
  }
  voice: {
    tone?: string[]
    style: string
    catchphrases?: string[]
    never_sounds_like: string
    examplePosts: string[]
  }
  worldview: {
    opinions?: { topic: string; stance: string; strength?: number }[]
    interests?: string[]
    dislikes?: string[]
  }
  contentPillars: ContentPillar[]
  boundaries: {
    bannedTopics: string[]
    disclosure: string
    neverDo: string[]
  }
  rhythm: {
    activeHours: string
    postsPerDay: [number, number]
    replyBudgetPerDay: number
  }
  seedArc?: {
    currentArc?: string
    runningBits?: string[]
  }
}

export class SoulSheetError extends Error {
  constructor(public readonly path: string, public readonly problems: string[]) {
    super(`invalid soul sheet at ${path}:\n  - ${problems.join('\n  - ')}`)
    this.name = 'SoulSheetError'
  }
}

export function loadSoulSheet(path: string): SoulSheet {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    throw new SoulSheetError(path, [`cannot read file: ${(e as Error).message}`])
  }
  const { valid, sheet, errors } = parseSoulSheet(raw)
  if (!valid) throw new SoulSheetError(path, errors)
  return sheet as SoulSheet
}
