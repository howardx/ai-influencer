// PlatformAdapter (spec §8) — the seam that keeps the engine platform-blind.
// XAdapter (HEX-22) talks to the X API directly; Instagram/TikTok arrive later
// as aggregator-backed adapters (spec §9); DemoAdapter dry-runs everything.
//
// Tenancy rule (spec §4): adapters take credentials as CONSTRUCTOR data,
// never global env — one process can host many personas with different
// accounts. Deliberately absent, forever: like/follow/repost/DM methods.
// The X automation rules ban them, so the interface cannot express them.

export interface PostRef {
  platform: string
  /** Platform-native id (tweet id, demo sequence, …) */
  id: string
  url?: string
}

export interface Mention {
  id: string
  authorHandle: string
  text: string
  createdAt: string
  /** Set when the mention is itself a reply in a thread */
  inReplyTo?: string
}

export interface PostMetrics {
  ref: PostRef
  impressions: number
  likes: number
  replies: number
  reposts: number
  capturedAt: string
}

/** Opaque pagination cursor; null means "from the beginning". */
export type Cursor = string | null

export interface MentionPage {
  mentions: Mention[]
  nextCursor: Cursor
}

export interface PlatformAdapter {
  readonly platform: string
  /**
   * `allowLink` is a cost guardrail (spec §6/§8): links in originals cost
   * $0.20/post vs $0.015 and get algorithmically throttled, so adapters
   * reject URLs unless the caller explicitly opts in (the /commercial path).
   */
  publishPost(p: { text: string; mediaPaths?: string[]; idempotencyKey: string; allowLink?: boolean }): Promise<PostRef>
  publishReply(p: { text: string; inReplyTo: string; idempotencyKey: string }): Promise<PostRef>
  deletePost(ref: PostRef): Promise<void>
  getMentions(since: Cursor): Promise<MentionPage>
  getPostMetrics(refs: PostRef[]): Promise<PostMetrics[]>
  getFollowerCount(): Promise<number>
}
