// Manual post CLI — publish one tweet through the real XAdapter. Used for
// warm-up-phase posting until the engine (HEX-23) takes over, and as the
// operator's escape hatch after that. (Posted the historic first tweet,
// 2026-07-07.)
//
//   cd agent
//   npx tsx --env-file=.env tools/post.ts "tweet text"
//   npx tsx --env-file=.env tools/post.ts "caption" ./photo.jpg
//   npx tsx --env-file=.env tools/post.ts --as kaylaliftsworld "tweet text"
//
// Persona tokens come from data/accounts.json (written by tools/x-oauth.ts):
// one stored account is used directly, several bring up a picker, --as skips
// the prompt. Token rotations save back to the store automatically.
import { createInterface } from 'node:readline/promises'
import { XAdapter } from '../src/adapters/x'
import { loadAccounts, resolveAccount, updateTokens, type StoredAccount } from '../src/accounts'

// argv: [--as handle] "text" [photoPath], any order for the flag
const argv = process.argv.slice(2)
const asIndex = argv.indexOf('--as')
const asHandle = asIndex === -1 ? undefined : argv[asIndex + 1]
const rest = asIndex === -1 ? argv : [...argv.slice(0, asIndex), ...argv.slice(asIndex + 2)]
const [text, mediaPath] = rest

if (!text) {
  console.error('Usage: npx tsx --env-file=.env tools/post.ts [--as handle] "tweet text" [photo path]')
  process.exit(1)
}
const { X_CLIENT_ID, X_CLIENT_SECRET } = process.env
if (!X_CLIENT_ID) {
  console.error('Missing X_CLIENT_ID in .env (see agent/.env.example).')
  process.exit(1)
}

const accounts = loadAccounts()
const resolved = resolveAccount(accounts, asHandle)
if (resolved.error) {
  console.error(resolved.error)
  process.exit(1)
}

let account: StoredAccount
if (resolved.account) {
  account = resolved.account
} else {
  // Several personas — pick one
  console.log('Which persona posts this?')
  accounts.forEach((a, i) => console.log(`  ${i + 1}. @${a.username} (${a.name})`))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`[1-${accounts.length}]: `)
  rl.close()
  const idx = Number(answer) - 1
  if (!Number.isInteger(idx) || idx < 0 || idx >= accounts.length) {
    console.error('invalid choice — aborting, nothing posted')
    process.exit(1)
  }
  account = accounts[idx]
}

const adapter = new XAdapter({
  clientId: X_CLIENT_ID,
  clientSecret: X_CLIENT_SECRET,
  accessToken: account.accessToken,
  refreshToken: account.refreshToken,
  onTokensRefreshed: t => updateTokens(account.userId, t),
  log: line => console.log(line),
})

// Belt and braces: confirm the token still belongs to the chosen persona
const meRes = await fetch('https://api.x.com/2/users/me', {
  headers: { authorization: `Bearer ${account.accessToken}` },
})
const me = (await meRes.json()) as { data?: { username: string } }
if (me.data && me.data.username.toLowerCase() !== account.username.toLowerCase()) {
  console.error(`REFUSING: stored entry says @${account.username} but the token belongs to @${me.data.username}. Re-run tools/x-oauth.ts.`)
  process.exit(1)
}

console.log(`posting as @${account.username}`)
const followers = await adapter.getFollowerCount()
console.log(`account ok — ${followers} followers`)

const ref = await adapter.publishPost({
  text,
  mediaPaths: mediaPath ? [mediaPath] : undefined,
  idempotencyKey: `manual-post-${account.username}-${text.slice(0, 32)}`,
})
console.log(`\nposted: ${ref.url}`)
