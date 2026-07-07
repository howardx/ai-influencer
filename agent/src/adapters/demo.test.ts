import { describe, it, expect, vi } from 'vitest'
import { DemoAdapter } from './demo'

describe('DemoAdapter', () => {
  it('records publishes without touching any network', async () => {
    const log = vi.fn()
    const demo = new DemoAdapter({ log })
    const ref = await demo.publishPost({ text: 'humbled again', idempotencyKey: 'k1' })
    expect(ref).toEqual({ platform: 'demo', id: 'demo-1' })
    expect(demo.published).toHaveLength(1)
    expect(log).toHaveBeenCalledWith('[demo] would publish post: humbled again')
  })

  it('is idempotent on the idempotency key (retry safety)', async () => {
    const demo = new DemoAdapter({ log: () => {} })
    const first = await demo.publishPost({ text: 'once', idempotencyKey: 'same' })
    const retry = await demo.publishPost({ text: 'once', idempotencyKey: 'same' })
    expect(retry).toEqual(first)
    expect(demo.published).toHaveLength(1)
  })

  it('supports replies, deletes, mentions, metrics and follower simulation', async () => {
    const demo = new DemoAdapter({ startingFollowers: 10, log: () => {} })
    const ref = await demo.publishReply({ text: 'so real', inReplyTo: 'x-123', idempotencyKey: 'r1' })
    expect(demo.published[0].inReplyTo).toBe('x-123')

    demo.simulateMention({
      id: 'm1', authorHandle: 'gymrat', text: 'form check?', createdAt: '2026-07-07T09:00:00.000Z',
    })
    const page = await demo.getMentions(null)
    expect(page.mentions).toHaveLength(1)
    // mentions drain once consumed
    expect((await demo.getMentions(null)).mentions).toHaveLength(0)

    const metrics = await demo.getPostMetrics([ref])
    expect(metrics[0].impressions).toBe(0)

    demo.simulateFollowerGrowth(5)
    expect(await demo.getFollowerCount()).toBe(15)

    await demo.deletePost(ref)
    expect(demo.published).toHaveLength(0)
  })
})
