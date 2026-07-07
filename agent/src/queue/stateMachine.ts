// Queue state machine (spec §7) — pure logic, no SQL (that lives in
// storage/db.ts). Terminal states have no outgoing edges: an expired or
// rejected item can never publish, which is what makes silence always safe.
//
//   draft → pending_approval → approved → published
//                           ↘ rejected (reason stored as voice lesson)
//                           ↘ expired  (never published)

export type QueueKind = 'original' | 'reply' | 'trend_take'

export type QueueStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'published'

export const TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'rejected', 'expired'],
  approved: ['published'],
  rejected: [],
  expired: [],
  published: [],
}

// Stale reactions read as bot behavior (spec §7): replies ~4h, trend takes
// ~8h. Originals only pass through the queue in draft mode / warm-up, where a
// day of staleness is acceptable.
export const EXPIRY_HOURS: Record<QueueKind, number> = {
  reply: 4,
  trend_take: 8,
  original: 24,
}

export function canTransition(from: QueueStatus, to: QueueStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function isTerminal(status: QueueStatus): boolean {
  return TRANSITIONS[status].length === 0
}

/** Deadline for a queue item created at `createdAtIso`. */
export function expiresAt(kind: QueueKind, createdAtIso: string): string {
  const created = new Date(createdAtIso)
  return new Date(created.getTime() + EXPIRY_HOURS[kind] * 3_600_000).toISOString()
}
