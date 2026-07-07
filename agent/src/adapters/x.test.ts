import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XAdapter, XApiError, XRateLimitError } from './x'

interface Scripted {
  match: (url: string, init: RequestInit) => boolean
  status: number
  body?: unknown
  headers?: Record<string, string>
}

/** Scripted fetch double: responses are consumed in order per matching call. */
function fakeFetch(script: Scripted[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const i = script.findIndex(s => s.match(String(url), init))
    if (i === -1) throw new Error(`unscripted fetch: ${init.method} ${url}`)
    const [s] = script.splice(i, 1)
    return new Response(s.body === undefined ? null : JSON.stringify(s.body), {
      status: s.status,
      headers: s.headers,
    })
  }) as typeof fetch
  return { impl, calls }
}

function adapter(script: Scripted[], extra: Partial<ConstructorParameters<typeof XAdapter>[0]> = {}) {
  const { impl, calls } = fakeFetch(script)
  const x = new XAdapter({
    clientId: 'client-1',
    accessToken: 'token-1',
    refreshToken: 'refresh-1',
    fetchImpl: impl,
    sleep: async () => {},
    ...extra,
  })
  return { x, calls }
}

describe('XAdapter', () => {
  it('publishes a post and returns the tweet ref', async () => {
    const { x, calls } = adapter([
      { match: u => u.endsWith('/2/tweets'), status: 201, body: { data: { id: '1234' } } },
    ])
    const ref = await x.publishPost({ text: 'humbled again', idempotencyKey: 'k1' })
    expect(ref).toEqual({ platform: 'x', id: '1234', url: 'https://x.com/i/status/1234' })
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer token-1')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ text: 'humbled again' })
  })

  it('never double-posts on the same idempotency key', async () => {
    const { x, calls } = adapter([
      { match: u => u.endsWith('/2/tweets'), status: 201, body: { data: { id: '1' } } },
    ])
    const first = await x.publishPost({ text: 'once', idempotencyKey: 'same' })
    const retry = await x.publishPost({ text: 'once', idempotencyKey: 'same' })
    expect(retry).toEqual(first)
    expect(calls).toHaveLength(1)
  })

  it('refuses links in originals unless allowLink (cost guardrail)', async () => {
    const { x, calls } = adapter([
      { match: u => u.endsWith('/2/tweets'), status: 201, body: { data: { id: '9' } } },
    ])
    await expect(
      x.publishPost({ text: 'check this https://sponsor.example', idempotencyKey: 'k' })
    ).rejects.toThrow(/refusing to post a link/)
    expect(calls).toHaveLength(0)
    // /commercial path opts in deliberately
    await x.publishPost({ text: 'new drop https://sponsor.example', idempotencyKey: 'k2', allowLink: true })
    expect(calls).toHaveLength(1)
  })

  it('replies with in_reply_to_tweet_id', async () => {
    const { x, calls } = adapter([
      { match: u => u.endsWith('/2/tweets'), status: 201, body: { data: { id: '2' } } },
    ])
    await x.publishReply({ text: 'so real', inReplyTo: '555', idempotencyKey: 'r1' })
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      text: 'so real',
      reply: { in_reply_to_tweet_id: '555' },
    })
  })

  it('refreshes rotated tokens on 401 and retries once', async () => {
    let saved: { accessToken: string; refreshToken?: string } | null = null
    const { x, calls } = adapter(
      [
        { match: (u, i) => u.endsWith('/2/tweets') && (i.headers as Record<string, string>).authorization === 'Bearer token-1', status: 401, body: {} },
        { match: u => u.endsWith('/2/oauth2/token'), status: 200, body: { access_token: 'token-2', refresh_token: 'refresh-2' } },
        { match: (u, i) => u.endsWith('/2/tweets') && (i.headers as Record<string, string>).authorization === 'Bearer token-2', status: 201, body: { data: { id: '3' } } },
      ],
      { onTokensRefreshed: t => { saved = t } }
    )
    const ref = await x.publishPost({ text: 'back online', idempotencyKey: 'k1' })
    expect(ref.id).toBe('3')
    expect(saved).toEqual({ accessToken: 'token-2', refreshToken: 'refresh-2' })
    const refreshCall = calls.find(c => c.url.endsWith('/2/oauth2/token'))
    expect(String(refreshCall?.init.body)).toContain('grant_type=refresh_token')
  })

  it('Basic-auths the refresh when a client secret is set (confidential Web App)', async () => {
    const { x, calls } = adapter(
      [
        { match: u => u.endsWith('/2/tweets'), status: 401, body: {} },
        { match: u => u.endsWith('/2/oauth2/token'), status: 200, body: { access_token: 'token-2' } },
        { match: (u, i) => u.endsWith('/2/tweets') && (i.headers as Record<string, string>).authorization === 'Bearer token-2', status: 201, body: { data: { id: '8' } } },
      ],
      { clientSecret: 'shhh' }
    )
    await x.publishPost({ text: 'confidential', idempotencyKey: 'k' })
    const refreshCall = calls.find(c => c.url.endsWith('/2/oauth2/token'))
    const auth = (refreshCall?.init.headers as Record<string, string>).authorization
    expect(auth).toBe('Basic ' + Buffer.from('client-1:shhh').toString('base64'))
  })

  it('surfaces 429 as XRateLimitError with the reset time (engine pauses the queue)', async () => {
    const reset = Math.floor(Date.parse('2026-07-07T12:34:56Z') / 1000)
    const { x } = adapter([
      { match: u => u.endsWith('/2/tweets'), status: 429, body: {}, headers: { 'x-rate-limit-reset': String(reset) } },
    ])
    const err = await x.publishPost({ text: 'hi', idempotencyKey: 'k' }).catch(e => e)
    expect(err).toBeInstanceOf(XRateLimitError)
    expect((err as XRateLimitError).resetAt.toISOString()).toBe('2026-07-07T12:34:56.000Z')
  })

  it('retries 5xx with backoff, then succeeds', async () => {
    const { x, calls } = adapter([
      { match: u => u.endsWith('/2/tweets'), status: 503, body: {} },
      { match: u => u.endsWith('/2/tweets'), status: 503, body: {} },
      { match: u => u.endsWith('/2/tweets'), status: 201, body: { data: { id: '4' } } },
    ])
    const ref = await x.publishPost({ text: 'persistent', idempotencyKey: 'k' })
    expect(ref.id).toBe('4')
    expect(calls).toHaveLength(3)
  })

  it('gives up after MAX_RETRIES on persistent 5xx', async () => {
    const script = Array.from({ length: 4 }, () => ({
      match: (u: string) => u.endsWith('/2/tweets'), status: 500, body: {},
    }))
    const { x } = adapter(script)
    const err = await x.publishPost({ text: 'down', idempotencyKey: 'k' }).catch(e => e)
    expect(err).toBeInstanceOf(XApiError)
    expect((err as XApiError).status).toBe(500)
  })

  it('deletes a post', async () => {
    const { x, calls } = adapter([
      { match: (u, i) => u.endsWith('/2/tweets/77') && i.method === 'DELETE', status: 200, body: { data: { deleted: true } } },
    ])
    await x.deletePost({ platform: 'x', id: '77' })
    expect(calls).toHaveLength(1)
  })

  it('maps mentions with author handles and advances the cursor', async () => {
    const { x, calls } = adapter([
      { match: u => u.endsWith('/2/users/me'), status: 200, body: { data: { id: 'u1' } } },
      {
        match: u => u.includes('/2/users/u1/mentions') && u.includes('since_id=100'),
        status: 200,
        body: {
          data: [{
            id: '101', text: '@kayla form check?', author_id: 'a9',
            created_at: '2026-07-07T09:00:00.000Z',
            referenced_tweets: [{ type: 'replied_to', id: '99' }],
          }],
          includes: { users: [{ id: 'a9', username: 'gymrat' }] },
          meta: { newest_id: '101' },
        },
      },
    ])
    const page = await x.getMentions('100')
    expect(page.mentions).toEqual([{
      id: '101', authorHandle: 'gymrat', text: '@kayla form check?',
      createdAt: '2026-07-07T09:00:00.000Z', inReplyTo: '99',
    }])
    expect(page.nextCursor).toBe('101')
    expect(calls).toHaveLength(2)
  })

  it('keeps the cursor when there are no new mentions', async () => {
    const { x } = adapter([
      { match: u => u.endsWith('/2/users/me'), status: 200, body: { data: { id: 'u1' } } },
      { match: u => u.includes('/mentions'), status: 200, body: { meta: {} } },
    ])
    const page = await x.getMentions('100')
    expect(page.mentions).toEqual([])
    expect(page.nextCursor).toBe('100')
  })

  it('maps post metrics from public_metrics', async () => {
    const { x } = adapter([
      {
        match: u => u.includes('/2/tweets?ids=1234'),
        status: 200,
        body: {
          data: [{
            id: '1234',
            public_metrics: { impression_count: 900, like_count: 40, reply_count: 6, retweet_count: 3, quote_count: 2 },
          }],
        },
      },
    ])
    const [m] = await x.getPostMetrics([{ platform: 'x', id: '1234' }])
    expect(m.impressions).toBe(900)
    expect(m.likes).toBe(40)
    expect(m.replies).toBe(6)
    expect(m.reposts).toBe(5)
  })

  it('reads follower count', async () => {
    const { x } = adapter([
      {
        match: u => u.includes('/2/users/me?user.fields=public_metrics'),
        status: 200,
        body: { data: { id: 'u1', public_metrics: { followers_count: 128 } } },
      },
    ])
    expect(await x.getFollowerCount()).toBe(128)
  })

  it('uploads a photo via initialize/append/finalize and attaches it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-media-'))
    const photo = join(dir, 'legday.jpg')
    writeFileSync(photo, Buffer.from('fake-jpeg-bytes'))
    try {
      const { x, calls } = adapter([
        { match: u => u.endsWith('/2/media/upload/initialize'), status: 200, body: { data: { id: 'm1' } } },
        { match: u => u.endsWith('/2/media/upload/m1/append'), status: 200, body: {} },
        { match: u => u.endsWith('/2/media/upload/m1/finalize'), status: 200, body: { data: { id: 'm1' } } },
        { match: u => u.endsWith('/2/tweets'), status: 201, body: { data: { id: '5' } } },
      ])
      const ref = await x.publishPost({ text: 'leg day', mediaPaths: [photo], idempotencyKey: 'k' })
      expect(ref.id).toBe('5')
      const initBody = JSON.parse(calls[0].init.body as string)
      expect(initBody).toEqual({ media_type: 'image/jpeg', total_bytes: 15, media_category: 'tweet_image' })
      expect(calls[1].init.body).toBeInstanceOf(FormData)
      const tweetBody = JSON.parse(calls[3].init.body as string)
      expect(tweetBody.media).toEqual({ media_ids: ['m1'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unsupported media types before any network call', async () => {
    const { x, calls } = adapter([])
    await expect(
      x.publishPost({ text: 'hi', mediaPaths: ['/tmp/file.tiff'], idempotencyKey: 'k' })
    ).rejects.toThrow(/unsupported media type/)
    expect(calls).toHaveLength(0)
  })
})
