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
    console.log('adapter: demo (dry-run — set X_CLIENT_ID + authorize a persona to go live)')
  }

  const claude = config.anthropicApiKey
    ? createClaudeClient({ apiKey: config.anthropicApiKey, model: process.env.ANTHROPIC_MODEL })
    : null
  if (!claude) console.log('no ANTHROPIC_API_KEY — scheduled slots will drop instead of drafting')

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
    loop.attachTelegram(bot)
    await bot.sendNote(`🤖 agent up for ${sheet.identity.name} on ${adapter.platform} — /status /pause /resume`).catch(e =>
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
