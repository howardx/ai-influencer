// Telegram surface (spec §7, HEX-24 minimal slice): approval cards with
// ✅ Post / ❌ Skip, the /pause /resume /status commands, and the log channel
// mirror with 🗑 fast-delete. Fetch-based long polling — no SDK dependency;
// fetch is injectable so the whole surface tests offline.
//
// The bot is deliberately storage-blind: decisions are delegated to handler
// callbacks, and the getUpdates offset persists through an injected store so
// a restart never replays old /pause–/resume toggles.
import type { QueueItem } from '../storage/db'

export interface TelegramHandlers {
  onApprove(itemId: string): Promise<string>   // returns feedback shown as a toast
  onReject(itemId: string): Promise<string>
  onDelete(postRef: string): Promise<string>   // 🗑 on log-channel mirrors
  onPause(): Promise<string>
  onResume(): Promise<string>
  onStatus(): Promise<string>
  /** /post <text> — publish EXACTLY this text now (no Claude; policy check only) */
  onPostVerbatim(text: string): Promise<string>
  /** /draft [hint] — Claude drafts in-voice from the hint → approval card */
  onDraft(hint: string): Promise<string>
}

export interface TelegramBotOptions {
  token: string
  /** Owner's chat — approval cards and command replies */
  chatId: string
  /** Muted log channel for auto-published mirrors; defaults to chatId */
  logChatId?: string
  handlers: TelegramHandlers
  offsetStore: { get(): number; set(offset: number): void }
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

interface TgUpdate {
  update_id: number
  message?: { chat: { id: number }; text?: string }
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } }
}

export class TelegramBot {
  private readonly base: string
  private readonly fetch: typeof fetch
  private readonly opts: TelegramBotOptions
  private readonly log: (line: string) => void

  constructor(opts: TelegramBotOptions) {
    this.opts = opts
    this.base = `https://api.telegram.org/bot${opts.token}`
    this.fetch = opts.fetchImpl ?? fetch
    this.log = opts.log ?? (() => {})
  }

  private async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await this.fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
    if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`)
    return json.result as T
  }

  /** Approval card: context + draft + countdown, ✅/❌ buttons. */
  async sendApprovalCard(item: QueueItem, contextLine: string, nowMs: number): Promise<void> {
    const remaining = item.expiresAt ? Math.max(0, Date.parse(item.expiresAt) - nowMs) : null
    const countdown = remaining === null
      ? ''
      : ` · expires in ${Math.floor(remaining / 3_600_000)}h ${Math.floor((remaining % 3_600_000) / 60_000)}m`
    const kindLabel = { reply: '💬 reply', trend_take: '📈 trend take', original: '📝 post' }[item.kind]
    await this.call('sendMessage', {
      chat_id: this.opts.chatId,
      text: `${kindLabel}${countdown}\n${contextLine}\n\n“${item.draftText}”`,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Post', callback_data: `approve:${item.id}` },
          { text: '❌ Skip', callback_data: `reject:${item.id}` },
        ]],
      },
    })
  }

  /** Log-channel mirror for auto-published originals, with 🗑 fast-delete. */
  async sendPublishedMirror(text: string, postRef: string, url?: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: this.opts.logChatId ?? this.opts.chatId,
      text: `📤 published${url ? `\n${url}` : ''}\n\n“${text}”`,
      reply_markup: {
        inline_keyboard: [[{ text: '🗑 Delete', callback_data: `delete:${postRef}` }]],
      },
    })
  }

  async sendNote(text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: this.opts.chatId, text })
  }

  /** One long-poll pass; call from the agent loop tick. */
  async poll(timeoutSeconds = 0): Promise<void> {
    const updates = await this.call<TgUpdate[]>('getUpdates', {
      offset: this.opts.offsetStore.get() + 1,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    })
    for (const update of updates) {
      this.opts.offsetStore.set(update.update_id)
      try {
        await this.handle(update)
      } catch (e) {
        this.log(`[telegram] handler error: ${(e as Error).message}`)
      }
    }
  }

  private async handle(update: TgUpdate): Promise<void> {
    const { handlers } = this.opts

    if (update.callback_query) {
      const q = update.callback_query
      // Ack FIRST and tolerate failure: callback queries expire within
      // seconds, and a decision must never look broken because a toast aged out
      await this.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {})
      // Strip the buttons so a second tap on the same card can't happen
      if (q.message) {
        await this.call('editMessageReplyMarkup', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {})
      }
      const [action, payload] = (q.data ?? '').split(/:(.*)/s)
      let feedback = 'unknown action'
      if (action === 'approve') feedback = await handlers.onApprove(payload)
      else if (action === 'reject') feedback = await handlers.onReject(payload)
      else if (action === 'delete') feedback = await handlers.onDelete(payload)
      // Durable feedback as a chat message, not a fragile toast
      await this.sendNote(feedback)
      return
    }

    const text = update.message?.text?.trim()
    if (!text || String(update.message?.chat.id) !== String(this.opts.chatId)) return
    const command = text.split(/[\s@]/)[0]
    const rest = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim() : ''
    if (command === '/pause') await this.sendNote(await handlers.onPause())
    else if (command === '/resume') await this.sendNote(await handlers.onResume())
    else if (command === '/status') await this.sendNote(await handlers.onStatus())
    else if (command === '/post') {
      await this.sendNote(rest
        ? await handlers.onPostVerbatim(rest)
        : 'usage: /post <exact text to publish> — or /draft [hint] to have her write it')
    }
    else if (command === '/draft') await this.sendNote(await handlers.onDraft(rest))
  }
}
