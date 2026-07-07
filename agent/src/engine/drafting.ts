// Drafting + critic (spec §6). One Claude call drafts in-voice from the soul
// sheet + memory; a second call judges it cold. Principle: SILENCE OVER SLOP
// — max 2 regenerations, then drop the slot. A missed post is invisible, a
// bad post isn't.
import type { ClaudeClient } from './claude'
import type { SoulSheet, ContentPillar } from './soul'
import type { ArcState } from '../storage/db'
import { checkPolicy } from './policy'

export interface DraftContext {
  /** Last ~15 published post texts, newest first (voice continuity) */
  recentPosts: string[]
  arc: ArcState | null
  /** For the near-duplicate policy check (last ~50) */
  recentTextsForDedup: string[]
}

export interface DraftResult {
  text: string | null
  /** Why the slot was dropped (all attempts rejected) — for the log channel */
  droppedBecause?: string
  /** The final rejected draft — surfaced so drops are debuggable, not mysterious */
  lastDraft?: string
  attempts: number
}

/**
 * Models decorate verdicts ("**PASS**", "Rejected — too corporate", …).
 * Normalize before judging: strip leading non-letters, uppercase.
 */
export function parseVerdict(raw: string): { pass: boolean; reason: string } {
  const normalized = raw.trim().replace(/^[^a-zA-Z]+/, '')
  const pass = normalized.toUpperCase().startsWith('PASS')
  const reason = pass ? '' : (normalized.replace(/^REJECT(?:ED)?[^a-zA-Z]*/i, '').trim() || 'critic gave no reason')
  return { pass, reason }
}

const MAX_ATTEMPTS = 3 // 1 draft + 2 regenerations

export function buildDraftSystem(sheet: SoulSheet): string {
  return [
    `You ARE ${sheet.identity.name} — ${sheet.identity.age ?? ''} ${sheet.identity.occupation ?? ''} in ${sheet.identity.city ?? 'her city'}. Not an assistant playing a character; the character.`,
    `Backstory: ${sheet.identity.backstory ?? ''}`,
    `Voice: ${sheet.voice.style}. Tone: ${(sheet.voice.tone ?? []).join(', ')}.`,
    sheet.voice.catchphrases?.length ? `Occasional catchphrases (rare, natural): ${sheet.voice.catchphrases.join(' · ')}` : '',
    `You NEVER sound like: ${sheet.voice.never_sounds_like}.`,
    `Never do: ${sheet.boundaries.neverDo.join('; ')}. Never touch: ${sheet.boundaries.bannedTopics.join(', ')}.`,
    '',
    'Posts that define your voice:',
    ...sheet.voice.examplePosts.map(p => `- ${p}`),
    '',
    'Write X posts. Output ONLY the post text — no quotes, no commentary, no hashtags unless the voice uses them.',
  ].filter(Boolean).join('\n')
}

export function buildDraftUser(pillar: ContentPillar, ctx: DraftContext, hint?: string): string {
  const parts = [
    ctx.arc ? `Life right now: ${ctx.arc.currentArc}. Running bits: ${ctx.arc.runningBits.join(' · ')}` : '',
    ctx.recentPosts.length
      ? `Your last posts (do NOT repeat their topics or phrasing):\n${ctx.recentPosts.slice(0, 15).map(p => `- ${p}`).join('\n')}`
      : 'You have not posted recently.',
    '',
    `Write ONE new post for the "${pillar.name}" pillar.`,
    pillar.name === 'photo drop' ? 'It will accompany a photo of you — caption energy, short.' : '',
    hint ? `Direction: ${hint}` : '',
    'Under 280 characters. Specific moment, not generic content.',
  ]
  return parts.filter(Boolean).join('\n')
}

export function buildCriticUser(sheet: SoulSheet, draft: string): string {
  return [
    `You are a ruthless editor for the X account of ${sheet.identity.name}. Her voice: ${sheet.voice.style}.`,
    `She never sounds like: ${sheet.voice.never_sounds_like}.`,
    'Posts that define the voice:',
    ...sheet.voice.examplePosts.slice(0, 5).map(p => `- ${p}`),
    '',
    `Candidate post:\n"${draft}"`,
    '',
    'Reject if it: sounds AI-generated or corporate, is engagement bait, drifts near her banned topics' +
      ` (${sheet.boundaries.bannedTopics.join(', ')}), or would embarrass a real person posting it.`,
    'Reply with exactly PASS, or REJECT: <one-line reason>.',
  ].join('\n')
}

/**
 * Draft a reply to a mention, with triage folded into the prompt: the model
 * may answer SKIP for trolls/bait/neverDo territory, which drops the mention
 * silently (spec §6 — not every mention deserves a reply).
 */
export async function draftReplyWithCritic(
  claude: ClaudeClient,
  sheet: SoulSheet,
  ctx: DraftContext,
  mention: { authorHandle: string; text: string }
): Promise<DraftResult> {
  const system = buildDraftSystem(sheet)
  const user = [
    `@${mention.authorHandle} wrote to you:\n"${mention.text}"`,
    '',
    ctx.arc ? `Life right now: ${ctx.arc.currentArc}.` : '',
    `If this is a troll, bait, drama, an apparent minor, or anything under your never-do list (${sheet.boundaries.neverDo.join('; ')}), reply with exactly SKIP.`,
    'Otherwise write ONE reply in your voice. Warm to regulars, brief always. Under 280 characters. Output only the reply text (or SKIP).',
  ].filter(Boolean).join('\n')

  const draft = (await claude.complete({ system, user, maxTokens: 200 }))
    .replace(/^["']|["']$/g, '').trim()
  if (draft.toUpperCase() === 'SKIP') {
    return { text: null, droppedBecause: 'triage: skipped', attempts: 1 }
  }

  const policy = checkPolicy(draft, sheet, { kind: 'reply', recentTexts: ctx.recentTextsForDedup })
  if (!policy.ok) return { text: null, droppedBecause: policy.violations.join('; '), attempts: 1 }

  const verdict = parseVerdict(await claude.complete({ user: buildCriticUser(sheet, draft), maxTokens: 100 }))
  if (!verdict.pass) {
    return { text: null, droppedBecause: verdict.reason, lastDraft: draft, attempts: 1 }
  }
  return { text: draft, attempts: 1 }
}

/** Draft → critic → policy, regenerating on rejection, up to MAX_ATTEMPTS. */
export async function draftWithCritic(
  claude: ClaudeClient,
  sheet: SoulSheet,
  pillar: ContentPillar,
  ctx: DraftContext,
  kind: 'original' | 'reply' | 'trend_take' = 'original',
  hint?: string,
  log: (line: string) => void = () => {}
): Promise<DraftResult> {
  const system = buildDraftSystem(sheet)
  let lastReason = ''
  let lastDraft = ''

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const retryHint = lastReason ? `${hint ? hint + '. ' : ''}Previous attempt rejected: ${lastReason}` : hint
    const draft = (await claude.complete({
      system,
      user: buildDraftUser(pillar, ctx, retryHint),
      maxTokens: 300,
    })).replace(/^["']|["']$/g, '').trim()
    lastDraft = draft
    log(`draft attempt ${attempt} (${pillar.name}): ${draft}`)

    const policy = checkPolicy(draft, sheet, { kind, recentTexts: ctx.recentTextsForDedup })
    if (!policy.ok) {
      lastReason = policy.violations.join('; ')
      log(`  → policy: ${lastReason}`)
      continue
    }

    const verdict = parseVerdict(await claude.complete({
      user: buildCriticUser(sheet, draft),
      maxTokens: 100,
    }))
    if (verdict.pass) {
      log(`  → critic: PASS`)
      return { text: draft, attempts: attempt }
    }
    lastReason = verdict.reason
    log(`  → critic: REJECT — ${lastReason}`)
  }

  return { text: null, droppedBecause: lastReason, lastDraft, attempts: MAX_ATTEMPTS }
}
