// DemoAdapter — dry-run PlatformAdapter (spec §4, HEX-24). Publishes nothing:
// every call is logged and recorded in memory. Used for local dev without
// secrets, tests, and the MVP demo fallback (HEX-25: no dependency on X
// uptime or a young account's trust level).
import type {
  Cursor, Mention, MentionPage, PlatformAdapter, PostMetrics, PostRef,
} from './types'

export interface DemoPublished {
  ref: PostRef
  text: string
  mediaPaths: string[]
  inReplyTo?: string
}

export class DemoAdapter implements PlatformAdapter {
  readonly platform = 'demo'
  /** Everything "published", in order — inspectable by tests and the demo UI. */
  readonly published: DemoPublished[] = []
  private seq = 0
  private followers: number
  private readonly log: (line: string) => void
  private readonly idempotencySeen = new Map<string, PostRef>()

  constructor(opts: { startingFollowers?: number; log?: (line: string) => void } = {}) {
    this.followers = opts.startingFollowers ?? 0
    this.log = opts.log ?? (line => console.log(line))
  }

  async publishPost(p: { text: string; mediaPaths?: string[]; idempotencyKey: string }): Promise<PostRef> {
    return this.record({ text: p.text, mediaPaths: p.mediaPaths ?? [], idempotencyKey: p.idempotencyKey })
  }

  async publishReply(p: { text: string; inReplyTo: string; idempotencyKey: string }): Promise<PostRef> {
    return this.record({ text: p.text, mediaPaths: [], inReplyTo: p.inReplyTo, idempotencyKey: p.idempotencyKey })
  }

  async deletePost(ref: PostRef): Promise<void> {
    const i = this.published.findIndex(p => p.ref.id === ref.id)
    if (i !== -1) this.published.splice(i, 1)
    this.log(`[demo] deleted ${ref.id}`)
  }

  async getMentions(_since: Cursor): Promise<MentionPage> {
    return { mentions: this.pendingMentions.splice(0), nextCursor: null }
  }

  async getPostMetrics(refs: PostRef[]): Promise<PostMetrics[]> {
    const now = new Date().toISOString()
    return refs.map(ref => ({
      ref, impressions: 0, likes: 0, replies: 0, reposts: 0, capturedAt: now,
    }))
  }

  async getFollowerCount(): Promise<number> {
    return this.followers
  }

  // ── demo controls (not part of PlatformAdapter) ────────────────────────

  /** Queue a fake mention so reply-triage flows can be exercised offline. */
  simulateMention(m: Mention): void {
    this.pendingMentions.push(m)
  }

  simulateFollowerGrowth(delta: number): void {
    this.followers += delta
  }

  private pendingMentions: Mention[] = []

  private record(p: { text: string; mediaPaths: string[]; inReplyTo?: string; idempotencyKey: string }): PostRef {
    const seen = this.idempotencySeen.get(p.idempotencyKey)
    if (seen) return seen
    this.seq += 1
    const ref: PostRef = { platform: this.platform, id: `demo-${this.seq}` }
    this.published.push({ ref, text: p.text, mediaPaths: p.mediaPaths, inReplyTo: p.inReplyTo })
    this.idempotencySeen.set(p.idempotencyKey, ref)
    const kind = p.inReplyTo ? `reply to ${p.inReplyTo}` : 'post'
    this.log(`[demo] would publish ${kind}: ${p.text}`)
    return ref
  }
}
