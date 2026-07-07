// The agent loop — one tick ties everything together (spec §6/§7):
//   expire overdue → process Telegram → (unless paused) plan the day →
//   draft+publish due originals → poll mentions → publish approved items.
// All clocks and randomness are injected; the daemon calls tick() on an
// interval, tests call it with a fake clock.
import { randomUUID } from 'node:crypto'
import type { Db, Tenant } from '../storage/db'
import {
  expireOverdueQueueItems, listDueQueueItems, listRecentPosts, getArcState,
  transitionQueueItem, setQueueItemDraftText, setQueueItemSchedule,
  getSetting, setSetting, recordActionCost, insertPost,
} from '../storage/db'
import type { SoulSheet } from './soul'
import type { ClaudeClient } from './claude'
import { planDay, pickPillars, type Rng } from './mixer'
import { localDayStartMs, localDateString } from './time'
import { draftWithCritic, draftReplyWithCritic } from './drafting'
import { checkPolicy } from './policy'
import {
  enqueuePlannedOriginal, enqueueForApproval, approveItem, rejectItem,
  publishDueApproved, isPaused, setPaused,
} from '../queue/service'
import type { PlatformAdapter } from '../adapters/types'
import type { TelegramBot, TelegramHandlers } from '../telegram/bot'

const WARMUP_DAYS = 14
const MENTIONS_INTERVAL_MS = 20 * 60_000
const MAX_REPLY_DRAFTS_PER_POLL = 3

export interface LoopDeps {
  db: Db
  sheet: SoulSheet
  adapter: PlatformAdapter
  claude: ClaudeClient | null
  rng: Rng
  now: () => number
  log: (line: string) => void
}

export class AgentLoop {
  private readonly d: LoopDeps
  readonly tenant: Tenant
  private telegram: TelegramBot | null = null
  private pollTelegramInTick = true

  constructor(deps: LoopDeps) {
    this.d = deps
    this.tenant = { personaId: deps.sheet.personaId, ownerId: deps.sheet.ownerId }
  }

  /**
   * externalPolling: the daemon runs a dedicated long-poll loop (button taps
   * must be answered within seconds — a 30s tick is too slow), so the tick
   * must NOT also call getUpdates: two concurrent pollers make Telegram 409.
   */
  attachTelegram(bot: TelegramBot, opts: { externalPolling?: boolean } = {}): void {
    this.telegram = bot
    this.pollTelegramInTick = !opts.externalPolling
  }

  /** Handlers for the Telegram buttons/commands — wire into TelegramBot. */
  get handlers(): TelegramHandlers {
    const { db, adapter, rng } = this.d
    return {
      onApprove: async id => {
        const res = approveItem(db, this.tenant, id, this.nowIso(), rng)
        return res.ok ? '✅ approved — posting in a few minutes' : `not posted: ${res.reason}`
      },
      onReject: async id => {
        const res = rejectItem(db, this.tenant, id, this.nowIso())
        return res.ok ? '❌ skipped' : `already handled: ${res.reason}`
      },
      onDelete: async refStr => {
        const [platform, id] = refStr.split(/:(.*)/s)
        await adapter.deletePost({ platform, id })
        return '🗑 deleted'
      },
      onPause: async () => {
        setPaused(db, this.tenant, true, this.nowIso())
        return '⏸ paused — NOTHING will publish until /resume'
      },
      onResume: async () => {
        setPaused(db, this.tenant, false, this.nowIso())
        return '▶️ resumed'
      },
      onStatus: async () => {
        const pending = listDueQueueItems(db, this.tenant, 'approved', '9999').length
        const followers = await adapter.getFollowerCount().catch(() => -1)
        return [
          isPaused(db, this.tenant) ? '⏸ PAUSED' : '▶️ running',
          this.inWarmUp() ? `🌱 warm-up until ${getSetting(db, this.tenant, 'warmup_until')?.slice(0, 10)}` : '',
          `platform: ${adapter.platform}`,
          followers >= 0 ? `followers: ${followers}` : '',
          `approved awaiting publish: ${pending}`,
        ].filter(Boolean).join('\n')
      },
      onPostVerbatim: text => this.postVerbatim(text),
      onDraft: hint => this.draftToCard(hint),
    }
  }

  /**
   * /post <text> — publish EXACTLY the owner's words, right now. No Claude:
   * the owner IS the author. The mechanical policy floor still applies
   * (banned topics, links, length) because it protects the account, not the voice.
   */
  private async postVerbatim(text: string): Promise<string> {
    const { db, sheet, adapter, log } = this.d
    if (isPaused(db, this.tenant)) return '⏸ paused — /resume first'

    const policy = checkPolicy(text, sheet, {
      kind: 'original',
      recentTexts: listRecentPosts(db, this.tenant, 50).map(p => p.text),
    })
    if (!policy.ok) return `refused by policy: ${policy.violations.join('; ')}`

    const id = randomUUID()
    const ref = await adapter.publishPost({ text, idempotencyKey: id })
    insertPost(db, {
      id, ...this.tenant, platform: ref.platform, platformRef: ref.id,
      pillar: null, isCommercial: false,
      text, mediaJson: null, postedAt: this.nowIso(),
    })
    recordActionCost(db, this.tenant, 'x.publish', 0.015, this.nowIso())
    log(`/post published verbatim: ${text}`)
    return `📤 posted: ${text}${ref.url ? `\n${ref.url}` : ''}`
  }

  /**
   * /draft [hint] — Claude drafts in her voice (critic + policy apply), then
   * an approval card arrives: ✅ publishes after the humanizing delay, ❌ or
   * 24h of silence drops it.
   */
  private async draftToCard(hint: string): Promise<string> {
    const { db, sheet, claude, rng, log } = this.d
    if (isPaused(db, this.tenant)) return '⏸ paused — /resume first'
    if (!claude) return 'no ANTHROPIC_API_KEY configured — cannot draft'

    const { pillars } = pickPillars(sheet, 1, rng, false)
    const pillar = pillars[0]
    const ctx = {
      recentPosts: listRecentPosts(db, this.tenant, 15).map(p => p.text),
      arc: getArcState(db, this.tenant),
      recentTextsForDedup: listRecentPosts(db, this.tenant, 50).map(p => p.text),
    }
    const result = await draftWithCritic(claude, sheet, pillar, ctx, 'original', hint || undefined, log)
    recordActionCost(db, this.tenant, 'claude.draft', 0, this.nowIso())
    if (!result.text) {
      return `dropped after ${result.attempts} attempt(s): ${result.droppedBecause}` +
        (result.lastDraft ? `\n\nlast rejected draft:\n“${result.lastDraft}”` : '')
    }

    const item = enqueueForApproval(db, this.tenant, {
      kind: 'original',
      draftText: result.text,
      contextJson: JSON.stringify({ pillar: pillar.name, hint: hint || undefined }),
      nowIso: this.nowIso(),
    })
    log(`/draft queued (${pillar.name}): ${result.text}`)
    if (this.telegram) {
      await this.telegram
        .sendApprovalCard(item, hint ? `your hint: “${hint}”` : `pillar: ${pillar.name}`, this.d.now())
        .catch(e => log(`card send failed: ${(e as Error).message}`))
    }
    return `📝 drafted — approve on the card above`
  }

  private nowIso(): string {
    return new Date(this.d.now()).toISOString()
  }

  private inWarmUp(): boolean {
    const until = getSetting(this.d.db, this.tenant, 'warmup_until')
    return until !== null && this.nowIso() < until
  }

  async tick(): Promise<void> {
    const { db, log } = this.d
    const nowIso = this.nowIso()

    const expired = expireOverdueQueueItems(db, nowIso)
    if (expired > 0) log(`expired ${expired} overdue queue item(s) — silence is safe`)

    // Telegram first: /pause must work even when everything else is on fire
    // (skipped when the daemon's dedicated poller owns getUpdates)
    if (this.telegram && this.pollTelegramInTick) {
      await this.telegram.poll().catch(e => log(`telegram poll failed: ${(e as Error).message}`))
    }

    if (isPaused(db, this.tenant)) return

    this.ensureWarmupWindow(nowIso)
    await this.ensureDayPlan()
    await this.draftDueOriginals()
    await this.pollMentions()
    await this.publishDue()
  }

  /** First run stamps the trust-ramp window (spec §6 warm-up mode). */
  private ensureWarmupWindow(nowIso: string): void {
    const { db } = this.d
    if (getSetting(db, this.tenant, 'warmup_until') === null) {
      const until = new Date(this.d.now() + WARMUP_DAYS * 86_400_000).toISOString()
      setSetting(db, this.tenant, 'warmup_until', until, nowIso)
      this.d.log(`warm-up mode until ${until.slice(0, 10)}: 1–2 posts/day, no replies`)
    }
  }

  /** Once per persona-local day: run the mixer, store the slots. */
  private async ensureDayPlan(): Promise<void> {
    const { db, sheet, rng, now, log } = this.d
    const tz = sheet.identity.timezone
    const today = localDateString(tz, now())
    if (getSetting(db, this.tenant, 'planned_day') === today) return

    const plan = planDay(sheet, {
      rng,
      dayStartMs: localDayStartMs(tz, now()),
      nowMs: now(),
      warmUp: this.inWarmUp(),
      photoAvailable: false, // media library lands with HEX-29
    })
    for (const slot of plan.slots) {
      enqueuePlannedOriginal(db, this.tenant, {
        pillar: slot.pillar.name, scheduledAtIso: slot.at, nowIso: this.nowIso(),
      })
    }
    setSetting(db, this.tenant, 'planned_day', today, this.nowIso())
    log(`planned ${plan.slots.length} slot(s) for ${today}: ${plan.slots.map(s => `${s.pillar.name} @ ${s.at.slice(11, 16)}`).join(', ') || 'none (rest day)'}`)
    if (plan.outOfPhotos && this.telegram) {
      await this.telegram.sendNote('📷 out of photos — photo drops downgraded to text until the library has media').catch(() => {})
    }
  }

  /** Slot time reached: draft with fresh memory, then auto-publish (hybrid autonomy). */
  private async draftDueOriginals(): Promise<void> {
    const { db, sheet, claude, rng, log } = this.d
    const due = listDueQueueItems(db, this.tenant, 'draft', this.nowIso())
    if (due.length === 0) return
    if (!claude) {
      log(`${due.length} slot(s) due but no ANTHROPIC_API_KEY — dropping (silence over slop)`)
      for (const item of due) transitionQueueItem(db, this.tenant, item.id, 'draft', 'expired', { reason: 'no drafting model' })
      return
    }

    const ctx = {
      recentPosts: listRecentPosts(db, this.tenant, 15).map(p => p.text),
      arc: getArcState(db, this.tenant),
      recentTextsForDedup: listRecentPosts(db, this.tenant, 50).map(p => p.text),
    }
    for (const item of due) {
      const pillarName = item.contextJson ? (JSON.parse(item.contextJson) as { pillar?: string }).pillar : undefined
      const pillar = sheet.contentPillars.find(p => p.name === pillarName) ?? sheet.contentPillars[0]
      const result = await draftWithCritic(claude, sheet, pillar, ctx, 'original', undefined, log)
      recordActionCost(db, this.tenant, 'claude.draft', 0, this.nowIso())

      if (!result.text) {
        transitionQueueItem(db, this.tenant, item.id, 'draft', 'expired', { reason: result.droppedBecause })
        log(`slot dropped (${pillar.name}): ${result.droppedBecause}`)
        continue
      }
      // Hybrid autonomy: originals auto-publish — walk the state machine with
      // an automatic approval, tiny jitter before the publish sweep picks it up
      setQueueItemDraftText(db, this.tenant, item.id, result.text)
      transitionQueueItem(db, this.tenant, item.id, 'draft', 'pending_approval')
      transitionQueueItem(db, this.tenant, item.id, 'pending_approval', 'approved', {
        decidedAt: this.nowIso(), reason: 'auto (original)',
      })
      setQueueItemSchedule(db, this.tenant, item.id, new Date(this.d.now() + rng() * 90_000).toISOString())
    }
  }

  /** Poll mentions (~20 min cadence), triage + draft replies, queue-gate them all. */
  private async pollMentions(): Promise<void> {
    const { db, sheet, adapter, claude, log } = this.d
    if (this.inWarmUp() || !claude || sheet.rhythm.replyBudgetPerDay === 0) return
    const last = getSetting(db, this.tenant, 'mentions_polled_at')
    if (last && this.d.now() - Date.parse(last) < MENTIONS_INTERVAL_MS) return
    setSetting(db, this.tenant, 'mentions_polled_at', this.nowIso(), this.nowIso())

    const cursor = getSetting(db, this.tenant, 'mentions_cursor')
    const page = await adapter.getMentions(cursor).catch(e => {
      log(`mentions poll failed: ${(e as Error).message}`)
      return null
    })
    if (!page) return
    if (page.nextCursor) setSetting(db, this.tenant, 'mentions_cursor', page.nextCursor, this.nowIso())
    recordActionCost(db, this.tenant, 'x.mentions', 0.001, this.nowIso())

    const ctx = {
      recentPosts: listRecentPosts(db, this.tenant, 15).map(p => p.text),
      arc: getArcState(db, this.tenant),
      recentTextsForDedup: [],
    }
    for (const mention of page.mentions.slice(0, MAX_REPLY_DRAFTS_PER_POLL)) {
      const result = await draftReplyWithCritic(claude, sheet, ctx, mention)
      if (!result.text) {
        log(`mention from @${mention.authorHandle} skipped: ${result.droppedBecause}`)
        continue
      }
      const item = enqueueForApproval(db, this.tenant, {
        kind: 'reply',
        draftText: result.text,
        contextJson: JSON.stringify({ inReplyTo: mention.id, author: mention.authorHandle, original: mention.text }),
        nowIso: this.nowIso(),
      })
      if (this.telegram) {
        await this.telegram
          .sendApprovalCard(item, `@${mention.authorHandle}: “${mention.text}”`, this.d.now())
          .catch(e => log(`card send failed: ${(e as Error).message}`))
      }
    }
  }

  /** Publish everything approved and past its humanizing delay; mirror to the log channel. */
  private async publishDue(): Promise<void> {
    const { db, adapter, log } = this.d
    const published = await publishDueApproved(db, this.tenant, adapter, this.nowIso())
    for (const item of published) {
      recordActionCost(db, this.tenant, 'x.publish', 0.015, this.nowIso())
      log(`published ${item.kind}: ${item.draftText}`)
      if (this.telegram && item.publishedRef) {
        const url = item.publishedRef.startsWith('x:')
          ? `https://x.com/i/status/${item.publishedRef.slice(2)}`
          : undefined
        await this.telegram.sendPublishedMirror(item.draftText, item.publishedRef, url).catch(() => {})
      }
    }
  }
}
