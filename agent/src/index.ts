// Persona agent daemon. Composition happens here — everything below is
// injected into AgentLoop, which is what the tests exercise directly.
//
//   npm run smoke     # no secrets: validate sheet, open DB, one dry-run publish
//   npm run dev       # daemon on DemoAdapter unless X creds + persona exist
//   DEMO_MODE=1 …     # force DemoAdapter even with credentials present
//
// Env (see .env.example): ANTHROPIC_API_KEY enables drafting; TELEGRAM_BOT_TOKEN
// + TELEGRAM_CHAT_ID enable the approval queue; persona tokens come from
// data/accounts.json (tools/x-oauth.ts).
import { join } from 'node:path'
import { connect } from 'node:net'
import { loadConfig } from './config'
import { loadSoulSheet } from './engine/soul'
import { openDb, getArcState, setArcState, getSetting, setSetting } from './storage/db'
import { DemoAdapter } from './adapters/demo'
import { XAdapter } from './adapters/x'
import { createClaudeClient } from './engine/claude'
import { AgentLoop } from './engine/loop'
import { TelegramBot } from './telegram/bot'
import { loadAccounts, resolveAccount, updateTokens } from './accounts'
import type { PlatformAdapter } from './adapters/types'

const TICK_MS = 30_000

// Same dev-machine reality vite.config.js handles: Anthropic geo-blocks some
// egress IPs; the owner's `us-on` SOCKS tunnel fixes browsers but Node
// ignores system proxies. Probe the tunnel and route Claude through it when
// up. AGENT_SOCKS_PROXY=<url> forces, =direct disables, unset auto-probes.
function socksTunnelUp(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect({ host, port, timeout: 300 })
    const done = (up: boolean) => { sock.destroy(); resolve(up) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.once('timeout', () => done(false))
  })
}

async function resolveClaudeProxy(): Promise<string | undefined> {
  const env = process.env.AGENT_SOCKS_PROXY
  if (env === 'direct') return undefined
  if (env) return env
  return (await socksTunnelUp('127.0.0.1', 10808)) ? 'socks5h://127.0.0.1:10808' : undefined
}

async function main(): Promise<void> {
  const config = loadConfig()
  const sheet = loadSoulSheet(config.soulSheetPath)
  const tenant = { personaId: sheet.personaId, ownerId: sheet.ownerId }
  console.log(`soul sheet ok: ${sheet.identity.name} (${sheet.personaId}), ` +
    `${sheet.contentPillars.length} pillars, ${sheet.voice.examplePosts.length} voice anchors`)

  const db = openDb(join(config.dataDir, `${sheet.personaId}.db`))
  console.log(`db ok: WAL=${db.pragma('journal_mode', { simple: true })}`)

  // Seed arc state once; after that the agent's memory owns it (spec §5)
  if (!getArcState(db, tenant) && sheet.seedArc) {
    setArcState(db, tenant, {
      currentArc: sheet.seedArc.currentArc ?? '',
      runningBits: sheet.seedArc.runningBits ?? [],
      updatedAt: new Date().toISOString(),
    })
    console.log('arc state seeded from soul sheet')
  }

  if (process.argv.includes('--smoke')) {
    const demo = new DemoAdapter()
    await demo.publishPost({ text: sheet.voice.examplePosts[0], idempotencyKey: 'smoke-1' })
    console.log(`smoke ok: ${demo.published.length} dry-run publish, nothing left the machine`)
    db.close()
    return
  }

  // ── adapter: real X only when a stored persona account matches the sheet ──
  let adapter: PlatformAdapter
  const accounts = loadAccounts()
  const stored = resolveAccount(accounts, process.env.X_PERSONA_HANDLE).account
    ?? (accounts.length === 1 ? accounts[0] : undefined)
  if (!process.env.DEMO_MODE && config.x?.clientId && stored) {
    adapter = new XAdapter({
      clientId: config.x.clientId,
      clientSecret: config.x.clientSecret,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      onTokensRefreshed: t => updateTokens(stored.userId, t),
      log: line => console.log(line),
    })
    console.log(`adapter: X as @${stored.username}`)
  } else {
    adapter = new DemoAdapter({ log: line => console.log(line) })
    const why = process.env.DEMO_MODE ? 'DEMO_MODE set'
      : !config.x?.clientId ? 'X_CLIENT_ID missing from env'
      : 'no authorized persona in data/accounts.json (run tools/x-oauth.ts)'
    console.log(`adapter: demo (dry-run — ${why})`)
  }

  let claude = null
  if (config.anthropicApiKey) {
    const socksProxyUrl = await resolveClaudeProxy()
    if (socksProxyUrl) console.log(`claude egress via SOCKS tunnel ${socksProxyUrl} (geo-block workaround)`)
    claude = createClaudeClient({
      apiKey: config.anthropicApiKey, model: process.env.ANTHROPIC_MODEL, socksProxyUrl,
    })
  } else {
    console.log('no ANTHROPIC_API_KEY — scheduled slots will drop instead of drafting')
  }

  const loop = new AgentLoop({
    db, sheet, adapter, claude,
    rng: Math.random,
    now: Date.now,
    log: line => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
  })

  const chatId = process.env.TELEGRAM_CHAT_ID
  if (config.telegramBotToken && chatId) {
    const bot = new TelegramBot({
      token: config.telegramBotToken,
      chatId,
      logChatId: process.env.TELEGRAM_LOG_CHAT_ID,
      handlers: loop.handlers,
      offsetStore: {
        get: () => Number(getSetting(db, tenant, 'tg_offset') ?? 0),
        set: n => setSetting(db, tenant, 'tg_offset', String(n), new Date().toISOString()),
      },
      log: line => console.log(line),
    })
    loop.attachTelegram(bot, { externalPolling: true })
    // Dedicated long-poll loop: button taps and commands answer in
    // milliseconds instead of waiting for the 30s engine tick (callback
    // queries expire in seconds). Errors back off briefly and retry.
    const pollTelegram = async () => {
      try {
        await bot.poll(25)
        setTimeout(pollTelegram, 250)
      } catch (e) {
        console.log(`telegram poll error: ${(e as Error).message}`)
        setTimeout(pollTelegram, 5_000)
      }
    }
    setTimeout(pollTelegram, 250)
    await bot.sendNote([
      `🤖 agent up for ${sheet.identity.name} on ${adapter.platform}`,
      '/status — state & queue',
      '/pause — kill switch (halts ALL publishing)',
      '/resume — resume publishing',
      '/post <text> — publish exactly this text now',
      '/draft <hint> — she drafts it in-voice → approval card',
    ].join('\n')).catch(e =>
      console.log(`telegram hello failed: ${e.message}`))
    console.log('telegram: connected')
  } else {
    console.log('telegram: not configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) — replies stay off, originals still auto-publish')
  }

  if (process.argv.includes('--once')) {
    await loop.tick()
    console.log('single tick complete')
    db.close()
    return
  }

  console.log(`agent loop starting (tick every ${TICK_MS / 1000}s)`)
  // Sequential ticks — never overlapping; a tick error logs and the next tick continues
  const run = async () => {
    try {
      await loop.tick()
    } catch (e) {
      console.error(`tick failed: ${(e as Error).message}`)
    } finally {
      setTimeout(run, TICK_MS)
    }
  }
  await run()
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
