// XAdapter — official X API v2 only (spec §8): no scraping, no unofficial
// clients. Credentials arrive as constructor data (tenancy rule), fetch and
// sleep are injectable so the whole adapter unit-tests offline; the first
// live tweet is the HEX-22 milestone once HEX-18 provides real tokens.
//
// Compliance posture is structural: this class only implements the
// PlatformAdapter surface — there is no code path for like/follow/repost/DM.
//
// NOTE: endpoint shapes (especially /2/media/upload/*) should be re-verified
// against the live API on the first end-to-end run — X has been migrating
// media upload from v1.1 to v2 and field names have shifted before.
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type {
  Cursor, Mention, MentionPage, PlatformAdapter, PostMetrics, PostRef,
} from './types'

const DEFAULT_API_BASE = 'https://api.x.com'
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_RETRIES = 3

export class XApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message)
    this.name = 'XApiError'
  }
}

/**
 * Thrown on HTTP 429. The engine reacts by pausing the queue until `resetAt`
 * (spec §11 failure handling) instead of hammering a rate-limited account —
 * pacing discipline is ban safety, not just cost control.
 */
export class XRateLimitError extends XApiError {
  constructor(body: string, public readonly resetAt: Date) {
    super(`X rate limit hit, resets at ${resetAt.toISOString()}`, 429, body)
    this.name = 'XRateLimitError'
  }
}

/** Durable idempotency storage can be plugged in later; Map covers one process. */
export interface IdempotencyStore {
  get(key: string): PostRef | undefined
  set(key: string, ref: PostRef): void
}

export interface XAdapterOptions {
  clientId: string
  accessToken: string
  refreshToken?: string
  /** Called whenever tokens rotate — persist them or the next restart is logged out. */
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken?: string }) => void
  idempotencyStore?: IdempotencyStore
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  apiBase?: string
  log?: (line: string) => void
}

const LINK_PATTERN = /https?:\/\/|www\./i

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
}

export class XAdapter implements PlatformAdapter {
  readonly platform = 'x'
  private accessToken: string
  private refreshToken?: string
  private readonly clientId: string
  private readonly onTokensRefreshed?: XAdapterOptions['onTokensRefreshed']
  private readonly idempotency: IdempotencyStore
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly apiBase: string
  private readonly log: (line: string) => void
  private refreshInFlight: Promise<void> | null = null
  private cachedUserId: string | null = null

  constructor(opts: XAdapterOptions) {
    this.clientId = opts.clientId
    this.accessToken = opts.accessToken
    this.refreshToken = opts.refreshToken
    this.onTokensRefreshed = opts.onTokensRefreshed
    const mem = new Map<string, PostRef>()
    this.idempotency = opts.idempotencyStore ?? { get: k => mem.get(k), set: (k, v) => mem.set(k, v) }
    this.fetch = opts.fetchImpl ?? fetch
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE
    this.log = opts.log ?? (() => {})
  }

  async publishPost(p: { text: string; mediaPaths?: string[]; idempotencyKey: string; allowLink?: boolean }): Promise<PostRef> {
    if (!p.allowLink && LINK_PATTERN.test(p.text)) {
      throw new Error(
        'refusing to post a link in an original ($0.20/post tier + algorithmic throttling); ' +
        'pass allowLink for the deliberate /commercial path'
      )
    }
    return this.publishOnce(p.idempotencyKey, async () => {
      const body: Record<string, unknown> = { text: p.text }
      if (p.mediaPaths?.length) {
        const ids = []
        for (const path of p.mediaPaths) ids.push(await this.uploadMedia(path))
        body.media = { media_ids: ids }
      }
      return this.createTweet(body)
    })
  }

  async publishReply(p: { text: string; inReplyTo: string; idempotencyKey: string }): Promise<PostRef> {
    return this.publishOnce(p.idempotencyKey, () =>
      this.createTweet({ text: p.text, reply: { in_reply_to_tweet_id: p.inReplyTo } })
    )
  }

  async deletePost(ref: PostRef): Promise<void> {
    await this.request(`/2/tweets/${ref.id}`, { method: 'DELETE' })
  }

  async getMentions(since: Cursor): Promise<MentionPage> {
    const userId = await this.userId()
    const params = new URLSearchParams({
      max_results: '50',
      'tweet.fields': 'created_at,referenced_tweets',
      expansions: 'author_id',
      'user.fields': 'username',
    })
    if (since) params.set('since_id', since)
    const json = await this.request<{
      data?: {
        id: string; text: string; author_id: string; created_at: string
        referenced_tweets?: { type: string; id: string }[]
      }[]
      includes?: { users?: { id: string; username: string }[] }
      meta?: { newest_id?: string }
    }>(`/2/users/${userId}/mentions?${params}`, { method: 'GET' })

    const handleById = new Map((json.includes?.users ?? []).map(u => [u.id, u.username]))
    const mentions: Mention[] = (json.data ?? []).map(t => ({
      id: t.id,
      authorHandle: handleById.get(t.author_id) ?? t.author_id,
      text: t.text,
      createdAt: t.created_at,
      inReplyTo: t.referenced_tweets?.find(r => r.type === 'replied_to')?.id,
    }))
    return { mentions, nextCursor: json.meta?.newest_id ?? since }
  }

  async getPostMetrics(refs: PostRef[]): Promise<PostMetrics[]> {
    if (refs.length === 0) return []
    const ids = refs.map(r => r.id).join(',')
    const json = await this.request<{
      data?: {
        id: string
        public_metrics: {
          impression_count: number; like_count: number; reply_count: number
          retweet_count: number; quote_count: number
        }
      }[]
    }>(`/2/tweets?ids=${ids}&tweet.fields=public_metrics`, { method: 'GET' })
    const byId = new Map((json.data ?? []).map(t => [t.id, t.public_metrics]))
    const now = new Date().toISOString()
    return refs.flatMap(ref => {
      const m = byId.get(ref.id)
      if (!m) return []
      return [{
        ref,
        impressions: m.impression_count,
        likes: m.like_count,
        replies: m.reply_count,
        reposts: m.retweet_count + m.quote_count,
        capturedAt: now,
      }]
    })
  }

  async getFollowerCount(): Promise<number> {
    const json = await this.request<{
      data: { id: string; public_metrics?: { followers_count: number } }
    }>('/2/users/me?user.fields=public_metrics', { method: 'GET' })
    this.cachedUserId = json.data.id
    return json.data.public_metrics?.followers_count ?? 0
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async publishOnce(key: string, publish: () => Promise<PostRef>): Promise<PostRef> {
    const seen = this.idempotency.get(key)
    if (seen) {
      this.log(`[x] idempotency hit for ${key} → ${seen.id}`)
      return seen
    }
    const ref = await publish()
    this.idempotency.set(key, ref)
    return ref
  }

  private async createTweet(body: Record<string, unknown>): Promise<PostRef> {
    const json = await this.request<{ data: { id: string } }>('/2/tweets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { platform: this.platform, id: json.data.id, url: `https://x.com/i/status/${json.data.id}` }
  }

  private async userId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId
    const json = await this.request<{ data: { id: string } }>('/2/users/me', { method: 'GET' })
    this.cachedUserId = json.data.id
    return this.cachedUserId
  }

  /** Chunked media upload (v2 initialize/append/finalize). Photos now; mp4 for /commercial. */
  private async uploadMedia(path: string): Promise<string> {
    const mime = MIME_BY_EXT[extname(path).toLowerCase()]
    if (!mime) throw new Error(`unsupported media type: ${basename(path)}`)
    const bytes = await readFile(path)
    const category = mime.startsWith('video/') ? 'tweet_video' : 'tweet_image'

    const init = await this.request<{ data: { id: string } }>('/2/media/upload/initialize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_type: mime, total_bytes: bytes.length, media_category: category }),
    })
    const mediaId = init.data.id

    for (let seg = 0; seg * UPLOAD_CHUNK_BYTES < bytes.length; seg++) {
      const chunk = bytes.subarray(seg * UPLOAD_CHUNK_BYTES, (seg + 1) * UPLOAD_CHUNK_BYTES)
      const form = new FormData()
      form.set('segment_index', String(seg))
      form.set('media', new Blob([chunk], { type: mime }), basename(path))
      await this.request(`/2/media/upload/${mediaId}/append`, { method: 'POST', body: form })
    }

    await this.request(`/2/media/upload/${mediaId}/finalize`, { method: 'POST' })
    this.log(`[x] uploaded ${basename(path)} → media ${mediaId}`)
    return mediaId
  }

  /**
   * Authenticated request with the failure policy from spec §8/§11:
   * 401 → refresh once and retry; 429 → typed rate-limit error so the engine
   * pauses the queue; 5xx/network → exponential backoff with jitter.
   */
  private async request<T = unknown>(pathname: string, init: RequestInit): Promise<T> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.fetch(`${this.apiBase}${pathname}`, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.accessToken}` },
        })
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw e
        await this.backoff(attempt)
        continue
      }

      if (res.ok) {
        return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
      }

      const body = await res.text()
      if (res.status === 401 && !refreshed && this.refreshToken) {
        refreshed = true
        await this.refreshTokens()
        continue
      }
      if (res.status === 429) {
        const resetHeader = res.headers.get('x-rate-limit-reset')
        const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : new Date(Date.now() + 15 * 60_000)
        throw new XRateLimitError(body, resetAt)
      }
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await this.backoff(attempt)
        continue
      }
      throw new XApiError(`X API ${init.method} ${pathname} → ${res.status}`, res.status, body)
    }
  }

  private backoff(attempt: number): Promise<void> {
    const ms = 500 * 2 ** attempt + Math.floor(Math.random() * 250)
    return this.sleep(ms)
  }

  /** OAuth 2.0 refresh (rotating tokens). Single-flight so parallel 401s refresh once. */
  private async refreshTokens(): Promise<void> {
    this.refreshInFlight ??= (async () => {
      const res = await this.fetch(`${this.apiBase}/2/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken as string,
          client_id: this.clientId,
        }),
      })
      if (!res.ok) {
        throw new XApiError('X token refresh failed — re-run the OAuth flow', res.status, await res.text())
      }
      const json = (await res.json()) as { access_token: string; refresh_token?: string }
      this.accessToken = json.access_token
      this.refreshToken = json.refresh_token ?? this.refreshToken
      this.onTokensRefreshed?.({ accessToken: this.accessToken, refreshToken: this.refreshToken })
      this.log('[x] tokens refreshed')
    })()
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }
}
