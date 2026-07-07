// Timezone helpers — the persona lives in HER timezone (sheet.identity), the
// server lives in UTC. Intl-based, no dependency.

/** Offset of `tz` from UTC in ms at the given instant (DST-aware). */
export function tzOffsetMs(tz: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(new Date(atMs)).map(p => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  )
  return asUtc - Math.floor(atMs / 1000) * 1000
}

/** Epoch ms of local midnight in `tz` for the day containing `nowMs`. */
export function localDayStartMs(tz: string, nowMs: number): number {
  const offset = tzOffsetMs(tz, nowMs)
  const local = new Date(nowMs + offset)
  const localMidnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  return localMidnightAsUtc - offset
}

/** YYYY-MM-DD of `nowMs` in `tz` — the plan-day key. */
export function localDateString(tz: string, nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs))
}
