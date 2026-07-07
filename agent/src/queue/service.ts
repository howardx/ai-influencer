// Queue service: the operations the Telegram buttons and the agent loop
// perform on queue items. Storage does the SQL; the state machine guards
// transitions; this module owns the decisions' side effects (humanizing
// delay, publish, post recording).
import { randomUUID } from 'node:crypto'
import type { Db, Tenant, QueueItem } from '../storage/db'
import {
  insertQueueItem, transitionQueueItem, getQueueItem, listDueQueueItems,
  setQueueItemSchedule, insertPost, getSetting, setSetting,
} from '../storage/db'
import { expiresAt, type QueueKind } from './stateMachine'
import type { PlatformAdapter } from '../adapters/types'
import type { Rng } from '../engine/mixer'

export const PAUSED_KEY = 'paused'

export function isPaused(db: Db, tenant: Tenant): boolean {
  return getSetting(db, tenant, PAUSED_KEY) === '1'
}

export function setPaused(db: Db, tenant: Tenant, paused: boolean, nowIso: string): void {
  setSetting(db, tenant, PAUSED_KEY, paused ? '1' : '0', nowIso)
}

/** Queue a draft for owner approval (replies, trend takes, draft-mode originals). */
export function enqueueForApproval(
  db: Db, tenant: Tenant,
  p: { kind: QueueKind; draftText: string; contextJson?: string; nowIso: string }
): QueueItem {
  const item: QueueItem = {
    id: randomUUID(),
    ...tenant,
    kind: p.kind,
    status: 'pending_approval',
    draftText: p.draftText,
    contextJson: p.contextJson ?? null,
    createdAt: p.nowIso,
    expiresAt: expiresAt(p.kind, p.nowIso),
    scheduledAt: null,
    decidedAt: null,
    decisionReason: null,
    publishedRef: null,
  }
  insertQueueItem(db, item)
  return item
}

/** Plan an original slot (mixer output): a draft waiting for its time. */
export function enqueuePlannedOriginal(
  db: Db, tenant: Tenant,
  p: { pillar: string; scheduledAtIso: string; nowIso: string }
): QueueItem {
  const item: QueueItem = {
    id: randomUUID(),
    ...tenant,
    kind: 'original',
    status: 'draft',
    draftText: '', // drafted lazily at slot time, with fresh memory
    contextJson: JSON.stringify({ pillar: p.pillar }),
    createdAt: p.nowIso,
    expiresAt: null,
    scheduledAt: p.scheduledAtIso,
    decidedAt: null,
    decisionReason: null,
    publishedRef: null,
  }
  insertQueueItem(db, item)
  return item
}

const APPROVE_DELAY_MIN_MS = 2 * 60_000
const APPROVE_DELAY_MAX_MS = 20 * 60_000

/**
 * Owner tapped ✅: approve and schedule publication after a randomized
 * 2–20 min delay (an instant reply to a 3h-old mention reads as a bot).
 */
export function approveItem(
  db: Db, tenant: Tenant, id: string, nowIso: string, rng: Rng
): { ok: boolean; reason?: string } {
  const item = getQueueItem(db, tenant, id)
  if (!item) return { ok: false, reason: 'not found' }
  if (item.status !== 'pending_approval') return { ok: false, reason: `already ${item.status}` }
  if (item.expiresAt && item.expiresAt <= nowIso) return { ok: false, reason: 'expired' }
  if (!transitionQueueItem(db, tenant, id, 'pending_approval', 'approved', { decidedAt: nowIso })) {
    return { ok: false, reason: 'already decided' }
  }
  const delay = APPROVE_DELAY_MIN_MS + rng() * (APPROVE_DELAY_MAX_MS - APPROVE_DELAY_MIN_MS)
  setQueueItemSchedule(db, tenant, id, new Date(Date.parse(nowIso) + delay).toISOString())
  return { ok: true }
}

export function rejectItem(
  db: Db, tenant: Tenant, id: string, nowIso: string, reason?: string
): { ok: boolean; reason?: string } {
  const item = getQueueItem(db, tenant, id)
  if (!item) return { ok: false, reason: 'not found' }
  if (item.status !== 'pending_approval') return { ok: false, reason: `already ${item.status}` }
  const ok = transitionQueueItem(db, tenant, id, 'pending_approval', 'rejected', {
    decidedAt: nowIso, reason,
  })
  return ok ? { ok } : { ok: false, reason: 'already decided' }
}

/**
 * Publish every approved item whose humanizing delay has elapsed.
 * The queue item id doubles as the idempotency key: a crash between publish
 * and the status write can never double-post on the next tick.
 */
export async function publishDueApproved(
  db: Db, tenant: Tenant, adapter: PlatformAdapter, nowIso: string
): Promise<QueueItem[]> {
  const published: QueueItem[] = []
  for (const item of listDueQueueItems(db, tenant, 'approved', nowIso)) {
    const context = item.contextJson ? JSON.parse(item.contextJson) as { inReplyTo?: string; pillar?: string } : {}
    const ref = context.inReplyTo
      ? await adapter.publishReply({ text: item.draftText, inReplyTo: context.inReplyTo, idempotencyKey: item.id })
      : await adapter.publishPost({ text: item.draftText, idempotencyKey: item.id })
    transitionQueueItem(db, tenant, item.id, 'approved', 'published', {
      publishedRef: `${ref.platform}:${ref.id}`,
    })
    insertPost(db, {
      id: item.id, ...tenant, platform: ref.platform, platformRef: ref.id,
      pillar: context.pillar ?? null, isCommercial: false,
      text: item.draftText, mediaJson: null, postedAt: nowIso,
    })
    published.push({ ...item, status: 'published', publishedRef: `${ref.platform}:${ref.id}` })
  }
  return published
}
