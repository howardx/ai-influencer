// Soul-sheet helpers for the Personality page: default sheet construction,
// the Claude seeding prompt, and response parsing. Pure functions so they
// unit-test without the page. Validation itself lives in shared/soul-sheet/
// (the same module the agent's loader uses).
import schema from '../../shared/soul-sheet/schema.json'
import { validateSoulSheet } from '../../shared/soul-sheet/validate.js'

export const PILLAR_NAMES = ['photo drop', 'gym take', 'daily-life texture', 'trend opinion']

const DEFAULT_PILLARS = [
  { name: 'photo drop', weight: 0.35, media: 'always' },
  { name: 'gym take', weight: 0.3, media: 'sometimes' },
  { name: 'daily-life texture', weight: 0.2, media: 'rarely' },
  { name: 'trend opinion', weight: 0.15, media: 'never', queueGated: true },
]

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles' }
  catch { return 'America/Los_Angeles' }
}

/** Blank-but-sensible sheet seeded from the influencer's existing profile. */
export function buildDefaultSoulSheet(influencer) {
  return {
    schemaVersion: 1,
    personaId: influencer.id,
    ownerId: 'local',
    identity: {
      name: influencer.name || '',
      ...(Number(influencer.age) >= 18 ? { age: Number(influencer.age) } : {}),
      city: '',
      occupation: '',
      backstory: influencer.backstory || '',
      timezone: browserTimezone(),
    },
    voice: {
      tone: [],
      style: influencer.voice || '',
      catchphrases: [],
      never_sounds_like: 'corporate, hashtag soup, motivational-poster quotes, AI-flavored enthusiasm',
      examplePosts: [],
    },
    worldview: {
      opinions: [],
      interests: (influencer.hobbies || '').split(',').map(s => s.trim()).filter(Boolean),
      dislikes: [],
    },
    contentPillars: DEFAULT_PILLARS.map(p => ({ ...p })),
    boundaries: {
      bannedTopics: ['politics', 'religion', 'health claims', 'financial advice'],
      disclosure: 'AI character — labeled automated account',
      neverDo: ['DMs', 'engage apparent minors', 'dogpiles or drama'],
    },
    rhythm: {
      activeHours: '07:00–23:30 local, quiet 13:00–15:00',
      postsPerDay: [2, 5],
      replyBudgetPerDay: 10,
    },
    seedArc: { currentArc: '', runningBits: [] },
  }
}

/** Prompt pair for aiComplete() — seeds the sheet from the visual profile. */
export function buildSeedPrompt(influencer) {
  const profile = {
    name: influencer.name,
    age: influencer.age,
    gender: influencer.gender,
    niche: influencer.nicheCustom || influencer.niche,
    backstory: influencer.backstory,
    hobbies: influencer.hobbies,
    clothingStyle: influencer.clothingStyle,
    physicalDescription: influencer.physicalDesc,
    voiceNotes: influencer.voice,
    audience: influencer.audience,
    introvertExtrovertScore: influencer.introExtrovert,
  }
  const system =
    'You design "soul sheets" — persona definitions for AI influencers who run their own X (Twitter) account. ' +
    'The persona must read as a specific, likable HUMAN with texture and mild flaws, never as a brand or an AI. ' +
    'Respond with ONLY a JSON object that validates against the provided JSON Schema. No markdown fences, no commentary.'
  const user = [
    'JSON Schema the output must validate against:',
    JSON.stringify(schema),
    '',
    'Influencer profile to build from:',
    JSON.stringify(profile, null, 2),
    '',
    'Requirements:',
    `- contentPillars: use exactly these four names with these flags: ${JSON.stringify(DEFAULT_PILLARS)} (tune the weights to the persona, they must sum to 1)`,
    '- voice.examplePosts: 6-8 posts under 280 chars in her exact voice — specific moments, not generic engagement bait',
    '- voice.never_sounds_like: name the clichés THIS persona is most at risk of',
    '- identity.age must be 18 or older; identity.timezone must be an IANA zone fitting her city',
    '- boundaries.disclosure must state she is an AI character on a labeled automated account',
    '- seedArc: a current life arc with 2-3 runningBits (recurring in-jokes)',
    `- schemaVersion 1, personaId "${influencer.id}", ownerId "local"`,
  ].join('\n')
  return { system, user }
}

/**
 * Parse Claude's response into a validated sheet.
 * Returns { sheet, errors } — sheet is null unless fully valid.
 */
export function parseSeedResponse(text, influencer) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { sheet: null, errors: ['response contained no JSON object'] }
  let sheet
  try {
    sheet = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    return { sheet: null, errors: [`response was not valid JSON: ${e.message}`] }
  }
  // Never trust the model with identity keys
  sheet.schemaVersion = 1
  sheet.personaId = influencer.id
  sheet.ownerId = sheet.ownerId || 'local'
  const { valid, errors } = validateSoulSheet(sheet)
  return { sheet: valid ? sheet : null, errors }
}

/** Trigger a JSON download of the sheet (agent-ready export). */
export function downloadSoulSheet(sheet) {
  const blob = new Blob([JSON.stringify(sheet, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(sheet.identity?.name || 'persona').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.soul.json`
  a.click()
  URL.revokeObjectURL(url)
}
