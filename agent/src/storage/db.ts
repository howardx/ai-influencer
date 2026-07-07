// The ONLY module that touches SQL (spec §4 DB discipline): plain SQL types +
// JSON text columns, no Node-specific serialization, so SQLite→Postgres is a
// mechanical migration and a non-JS agent can read the same data. Every table
// is keyed by persona_id + owner_id from day one (tenancy rule) — the SaaS
// phase must not require a schema change.
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canTransition, type QueueKind, type QueueStatus } from '../queue/stateMachine'

export type Db = Database.Database

export interface Tenant {
  personaId: string
  ownerId: string
}

export interface QueueItem extends Tenant {
  id: string
  kind: QueueKind
  status: QueueStatus
  draftText: string
  /** JSON text: target tweet, trend rationale, fan notes — shape owned by callers */
  contextJson: string | null
  createdAt: string
  expiresAt: string | null
  decidedAt: string | null
  decisionReason: string | null
  publishedRef: string | null
}

// Append-only list; user_version tracks how many have been applied.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE posts (
    id            TEXT PRIMARY KEY,
    persona_id    TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    platform      TEXT NOT NULL,
    platform_ref  TEXT,
    pillar        TEXT,
    is_commercial INTEGER NOT NULL DEFAULT 0,
    text          TEXT NOT NULL,
    media_json    TEXT,
    posted_at     TEXT NOT NULL
  );
  CREATE INDEX idx_posts_tenant_time ON posts(persona_id, owner_id, posted_at);

  CREATE TABLE queue_items (
    id              TEXT PRIMARY KEY,
    persona_id      TEXT NOT NULL,
    owner_id        TEXT NOT NULL,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL,
    draft_text      TEXT NOT NULL,
    context_json    TEXT,
    created_at      TEXT NOT NULL,
    expires_at      TEXT,
    decided_at      TEXT,
    decision_reason TEXT,
    published_ref   TEXT
  );
  CREATE INDEX idx_queue_tenant_status ON queue_items(persona_id, owner_id, status);

  CREATE TABLE arc_state (
    persona_id        TEXT NOT NULL,
    owner_id          TEXT NOT NULL,
    current_arc       TEXT NOT NULL DEFAULT '',
    running_bits_json TEXT NOT NULL DEFAULT '[]',
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (persona_id, owner_id)
  );

  CREATE TABLE fan_notes (
    persona_id   TEXT NOT NULL,
    owner_id     TEXT NOT NULL,
    handle       TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    interactions INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    PRIMARY KEY (persona_id, owner_id, handle)
  );

  CREATE TABLE action_costs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    persona_id TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    action     TEXT NOT NULL,
    cost_usd   REAL NOT NULL,
    at         TEXT NOT NULL
  );
  CREATE INDEX idx_costs_tenant_time ON action_costs(persona_id, owner_id, at);
  `,
]

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const applied = db.pragma('user_version', { simple: true }) as number
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i])
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
}

// ── queue ────────────────────────────────────────────────────────────────

export function insertQueueItem(db: Db, item: QueueItem): void {
  db.prepare(
    `INSERT INTO queue_items
       (id, persona_id, owner_id, kind, status, draft_text, context_json,
        created_at, expires_at, decided_at, decision_reason, published_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item.id, item.personaId, item.ownerId, item.kind, item.status,
    item.draftText, item.contextJson, item.createdAt, item.expiresAt,
    item.decidedAt, item.decisionReason, item.publishedRef
  )
}

/**
 * Guarded status transition: enforces the state machine AND the current
 * status in the same UPDATE, so concurrent deciders can't double-apply.
 * Returns false if the item wasn't in `from` (or the transition is illegal).
 */
export function transitionQueueItem(
  db: Db,
  tenant: Tenant,
  id: string,
  from: QueueStatus,
  to: QueueStatus,
  opts: { decidedAt?: string; reason?: string; publishedRef?: string } = {}
): boolean {
  if (!canTransition(from, to)) return false
  const result = db.prepare(
    `UPDATE queue_items
       SET status = ?, decided_at = COALESCE(?, decided_at),
           decision_reason = COALESCE(?, decision_reason),
           published_ref = COALESCE(?, published_ref)
     WHERE id = ? AND persona_id = ? AND owner_id = ? AND status = ?`
  ).run(
    to, opts.decidedAt ?? null, opts.reason ?? null, opts.publishedRef ?? null,
    id, tenant.personaId, tenant.ownerId, from
  )
  return result.changes === 1
}

export function getQueueItem(db: Db, tenant: Tenant, id: string): QueueItem | null {
  const row = db.prepare(
    `SELECT * FROM queue_items WHERE id = ? AND persona_id = ? AND owner_id = ?`
  ).get(id, tenant.personaId, tenant.ownerId) as Record<string, unknown> | undefined
  return row ? rowToQueueItem(row) : null
}

export function listQueueItems(db: Db, tenant: Tenant, status?: QueueStatus): QueueItem[] {
  const rows = (status
    ? db.prepare(
        `SELECT * FROM queue_items
         WHERE persona_id = ? AND owner_id = ? AND status = ? ORDER BY created_at`
      ).all(tenant.personaId, tenant.ownerId, status)
    : db.prepare(
        `SELECT * FROM queue_items
         WHERE persona_id = ? AND owner_id = ? ORDER BY created_at`
      ).all(tenant.personaId, tenant.ownerId)) as Record<string, unknown>[]
  return rows.map(rowToQueueItem)
}

/**
 * Expire every pending item past its deadline (spec §7: expiry is a feature —
 * expired items never publish; silence is always safe). Runs across ALL
 * tenants: it is the safety sweep, not a per-persona query.
 * Returns the number of items expired.
 */
export function expireOverdueQueueItems(db: Db, nowIso: string): number {
  return db.prepare(
    `UPDATE queue_items
       SET status = 'expired', decided_at = ?
     WHERE status = 'pending_approval' AND expires_at IS NOT NULL AND expires_at <= ?`
  ).run(nowIso, nowIso).changes
}

function rowToQueueItem(row: Record<string, unknown>): QueueItem {
  return {
    id: row.id as string,
    personaId: row.persona_id as string,
    ownerId: row.owner_id as string,
    kind: row.kind as QueueKind,
    status: row.status as QueueStatus,
    draftText: row.draft_text as string,
    contextJson: row.context_json as string | null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string | null,
    decidedAt: row.decided_at as string | null,
    decisionReason: row.decision_reason as string | null,
    publishedRef: row.published_ref as string | null,
  }
}

// ── posts ────────────────────────────────────────────────────────────────

export interface PostRecord extends Tenant {
  id: string
  platform: string
  platformRef: string | null
  pillar: string | null
  isCommercial: boolean
  text: string
  /** JSON text: array of media paths/refs */
  mediaJson: string | null
  postedAt: string
}

export function insertPost(db: Db, post: PostRecord): void {
  db.prepare(
    `INSERT INTO posts
       (id, persona_id, owner_id, platform, platform_ref, pillar,
        is_commercial, text, media_json, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    post.id, post.personaId, post.ownerId, post.platform, post.platformRef,
    post.pillar, post.isCommercial ? 1 : 0, post.text, post.mediaJson, post.postedAt
  )
}

export function listRecentPosts(db: Db, tenant: Tenant, limit: number): PostRecord[] {
  const rows = db.prepare(
    `SELECT * FROM posts WHERE persona_id = ? AND owner_id = ?
     ORDER BY posted_at DESC LIMIT ?`
  ).all(tenant.personaId, tenant.ownerId, limit) as Record<string, unknown>[]
  return rows.map(row => ({
    id: row.id as string,
    personaId: row.persona_id as string,
    ownerId: row.owner_id as string,
    platform: row.platform as string,
    platformRef: row.platform_ref as string | null,
    pillar: row.pillar as string | null,
    isCommercial: row.is_commercial === 1,
    text: row.text as string,
    mediaJson: row.media_json as string | null,
    postedAt: row.posted_at as string,
  }))
}

// ── arc state ────────────────────────────────────────────────────────────

export interface ArcState {
  currentArc: string
  runningBits: string[]
  updatedAt: string
}

export function getArcState(db: Db, tenant: Tenant): ArcState | null {
  const row = db.prepare(
    `SELECT current_arc, running_bits_json, updated_at
     FROM arc_state WHERE persona_id = ? AND owner_id = ?`
  ).get(tenant.personaId, tenant.ownerId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    currentArc: row.current_arc as string,
    runningBits: JSON.parse(row.running_bits_json as string),
    updatedAt: row.updated_at as string,
  }
}

export function setArcState(db: Db, tenant: Tenant, arc: ArcState): void {
  db.prepare(
    `INSERT INTO arc_state (persona_id, owner_id, current_arc, running_bits_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (persona_id, owner_id) DO UPDATE SET
       current_arc = excluded.current_arc,
       running_bits_json = excluded.running_bits_json,
       updated_at = excluded.updated_at`
  ).run(tenant.personaId, tenant.ownerId, arc.currentArc, JSON.stringify(arc.runningBits), arc.updatedAt)
}

// ── action costs ─────────────────────────────────────────────────────────

export function recordActionCost(
  db: Db, tenant: Tenant, action: string, costUsd: number, atIso: string
): void {
  db.prepare(
    `INSERT INTO action_costs (persona_id, owner_id, action, cost_usd, at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tenant.personaId, tenant.ownerId, action, costUsd, atIso)
}
