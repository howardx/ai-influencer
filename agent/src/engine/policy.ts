// Mechanical policy check (spec §6) — runs on EVERY post including
// auto-published originals. This is the deterministic floor under the
// critic: no judgment calls, just rules. Pure functions, fully tested.
import type { SoulSheet } from './soul'

export interface PolicyVerdict {
  ok: boolean
  violations: string[]
}

const LINK_PATTERN = /https?:\/\/|\bwww\./i
const MENTION_PATTERN = /(^|[^\w])@[a-z0-9_]{1,15}/i
const MAX_LENGTH = 280
const NEAR_DUP_THRESHOLD = 0.6

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? [])
}

/** Jaccard similarity on word sets — cheap stand-in for X's "substantially similar" rule. */
export function similarity(a: string, b: string): number {
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / (wa.size + wb.size - shared)
}

export function checkPolicy(
  text: string,
  sheet: SoulSheet,
  opts: { kind: 'original' | 'reply' | 'trend_take'; recentTexts: string[] }
): PolicyVerdict {
  const violations: string[] = []

  if (text.trim().length === 0) violations.push('empty draft')
  if (text.length > MAX_LENGTH) violations.push(`too long (${text.length} > ${MAX_LENGTH})`)

  const lower = text.toLowerCase()
  for (const topic of sheet.boundaries.bannedTopics) {
    if (topic && lower.includes(topic.toLowerCase())) violations.push(`banned topic: ${topic}`)
  }

  if (opts.kind !== 'reply') {
    // Originals: no links ($0.20 tier + throttling), no @-mentions (reads as
    // reply-guy spam from an automated account)
    if (LINK_PATTERN.test(text)) violations.push('link in original')
    if (MENTION_PATTERN.test(text)) violations.push('@-mention in original')
  }

  for (const prior of opts.recentTexts) {
    if (similarity(text, prior) >= NEAR_DUP_THRESHOLD) {
      violations.push(`near-duplicate of a recent post (${Math.round(similarity(text, prior) * 100)}% similar)`)
      break
    }
  }

  return { ok: violations.length === 0, violations }
}
