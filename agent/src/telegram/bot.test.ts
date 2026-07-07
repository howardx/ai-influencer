import { describe, it, expect, vi } from 'vitest'
import { TelegramBot, type TelegramHandlers } from './bot'
import type { QueueItem } from '../storage/db'

function makeBot(updates: unknown[] = [], failMethods: string[] = []) {
  const sent: { method: string; params: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!
    const params = JSON.parse(String(init?.body ?? '{}'))
    sent.push({ method, params })
    if (failMethods.includes(method)) {
      return new Response(JSON.stringify({ ok: false, description: 'query is too old' }), { status: 400 })
    }
    const result = method === 'getUpdates' ? updates.splice(0) : {}
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  }) as typeof fetch

  const handlers: TelegramHandlers = {
    onApprove: vi.fn(async id => `approved ${id}`),
    onReject: vi.fn(async id => `rejected ${id}`),
    onDelete: vi.fn(async ref => `deleted ${ref}`),
    onPause: vi.fn(async () => 'paused'),
    onResume: vi.fn(async () => 'resumed'),
    onStatus: vi.fn(async () => 'status text'),
    onPostVerbatim: vi.fn(async text => `posted: ${text}`),
    onDraft: vi.fn(async hint => `drafted (hint: ${hint})`),
  }
  let offset = 0
  const bot = new TelegramBot({
    token: 'tg-token', chatId: '42', handlers, fetchImpl,
    offsetStore: { get: () => offset, set: n => { offset = n } },
  })
  return { bot, sent, handlers, offset: () => offset }
}

const item: QueueItem = {
  id: 'q1', personaId: 'kayla-v1', ownerId: 'howard', kind: 'reply',
  status: 'pending_approval', draftText: 'so real',
  contextJson: null, createdAt: '2026-07-08T10:00:00.000Z',
  expiresAt: '2026-07-08T14:00:00.000Z', scheduledAt: null,
  decidedAt: null, decisionReason: null, publishedRef: null,
}

describe('TelegramBot', () => {
  it('sends an approval card with countdown and ✅/❌ buttons', async () => {
    const { bot, sent } = makeBot()
    await bot.sendApprovalCard(item, '@gymrat: “form check?”', Date.parse('2026-07-08T10:47:00.000Z'))
    const msg = sent[0]
    expect(msg.method).toBe('sendMessage')
    expect(msg.params.text).toContain('💬 reply · expires in 3h 13m')
    expect(msg.params.text).toContain('so real')
    const keyboard = (msg.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]
    expect(keyboard.map(b => b.callback_data)).toEqual(['approve:q1', 'reject:q1'])
  })

  it('acks first, strips the buttons, then delivers feedback as a message', async () => {
    const { bot, sent, handlers } = makeBot([
      { update_id: 7, callback_query: { id: 'cb1', data: 'approve:q1', message: { chat: { id: 42 }, message_id: 9 } } },
      { update_id: 8, callback_query: { id: 'cb2', data: 'delete:x:12345' } },
    ])
    await bot.poll()
    expect(handlers.onApprove).toHaveBeenCalledWith('q1')
    expect(handlers.onDelete).toHaveBeenCalledWith('x:12345') // split survives the extra colon
    // ack happens before the handler result exists — no text on it
    const methods = sent.map(s => s.method)
    expect(methods.indexOf('answerCallbackQuery')).toBeLessThan(methods.indexOf('sendMessage'))
    // buttons removed from the tapped card (only the first update carried a message ref)
    const strip = sent.find(s => s.method === 'editMessageReplyMarkup')!
    expect(strip.params).toMatchObject({ chat_id: 42, message_id: 9, reply_markup: { inline_keyboard: [] } })
    // durable feedback as chat messages
    const notes = sent.filter(s => s.method === 'sendMessage').map(s => s.params.text)
    expect(notes).toEqual(['approved q1', 'deleted x:12345'])
  })

  it('an expired callback ack never blocks the decision (the exact live failure)', async () => {
    const { bot, sent, handlers } = makeBot(
      [{ update_id: 7, callback_query: { id: 'stale', data: 'approve:q1' } }],
      ['answerCallbackQuery'] // Telegram: "query is too old"
    )
    await bot.poll()
    expect(handlers.onApprove).toHaveBeenCalledWith('q1')
    expect(sent.filter(s => s.method === 'sendMessage').map(s => s.params.text)).toEqual(['approved q1'])
  })

  it('handles /pause /resume /status from the owner chat only', async () => {
    const { bot, sent, handlers } = makeBot([
      { update_id: 1, message: { chat: { id: 42 }, text: '/pause' } },
      { update_id: 2, message: { chat: { id: 999 }, text: '/resume' } }, // stranger — ignored
      { update_id: 3, message: { chat: { id: 42 }, text: '/status' } },
    ])
    await bot.poll()
    expect(handlers.onPause).toHaveBeenCalled()
    expect(handlers.onResume).not.toHaveBeenCalled()
    expect(handlers.onStatus).toHaveBeenCalled()
    const notes = sent.filter(s => s.method === 'sendMessage').map(s => s.params.text)
    expect(notes).toEqual(['paused', 'status text'])
  })

  it('routes /post (verbatim) and /draft (hint), with usage help for bare /post', async () => {
    const { bot, sent, handlers } = makeBot([
      { update_id: 1, message: { chat: { id: 42 }, text: '/post' } },
      { update_id: 2, message: { chat: { id: 42 }, text: '/post exactly these words' } },
      { update_id: 3, message: { chat: { id: 42 }, text: '/draft something about rest days' } },
      { update_id: 4, message: { chat: { id: 42 }, text: '/draft' } },
    ])
    await bot.poll()
    expect(handlers.onPostVerbatim).toHaveBeenCalledTimes(1)
    expect(handlers.onPostVerbatim).toHaveBeenCalledWith('exactly these words')
    expect(handlers.onDraft).toHaveBeenNthCalledWith(1, 'something about rest days')
    expect(handlers.onDraft).toHaveBeenNthCalledWith(2, '')
    const notes = sent.filter(s => s.method === 'sendMessage').map(s => String(s.params.text))
    expect(notes[0]).toMatch(/usage: \/post/)
    expect(notes[1]).toBe('posted: exactly these words')
  })

  it('advances the offset store so restarts never replay updates', async () => {
    const { bot, sent, offset } = makeBot([
      { update_id: 41, message: { chat: { id: 42 }, text: '/status' } },
    ])
    await bot.poll()
    expect(offset()).toBe(41)
    await bot.poll()
    const polls = sent.filter(s => s.method === 'getUpdates')
    expect(polls[1].params.offset).toBe(42)
  })

  it('one failing handler does not break the poll pass', async () => {
    const { bot, handlers } = makeBot([
      { update_id: 1, callback_query: { id: 'cb1', data: 'approve:boom' } },
      { update_id: 2, message: { chat: { id: 42 }, text: '/status' } },
    ])
    ;(handlers.onApprove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    await bot.poll()
    expect(handlers.onStatus).toHaveBeenCalled()
  })
})
