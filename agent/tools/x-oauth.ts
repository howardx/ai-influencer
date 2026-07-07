// One-shot OAuth 2.0 (PKCE) authorizer for a persona account (HEX-18).
//
//   cd agent
//   X_CLIENT_ID=... X_CLIENT_SECRET=... npx tsx tools/x-oauth.ts
//
// Then open the printed URL in a browser session logged in as the PERSONA
// account (not your personal one), approve, and paste the printed env lines
// into agent/.env (local) or /etc/persona-agent/env (Hetzner).
//
// Scopes are the compliance boundary (spec §8): tweet.read tweet.write
// users.read media.write offline.access — media.write is required by the v2
// media upload endpoints for photo posts; there is deliberately NO
// like.write / follows.write / dm.write, so the tokens themselves cannot
// like, follow, or DM even if code tried.
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { saveAccount, accountsPath } from '../src/accounts'

const CLIENT_ID = process.env.X_CLIENT_ID
const CLIENT_SECRET = process.env.X_CLIENT_SECRET // set for confidential (Web App) clients
const PORT = Number(process.env.OAUTH_PORT || 8787)
const REDIRECT_URI = `http://localhost:${PORT}/callback`
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access']

if (!CLIENT_ID) {
  console.error('Set X_CLIENT_ID (and X_CLIENT_SECRET for a confidential app) first.')
  process.exit(1)
}

const b64url = (buf: Buffer) => buf.toString('base64url')
const verifier = b64url(randomBytes(32))
const challenge = b64url(createHash('sha256').update(verifier).digest())
const state = b64url(randomBytes(16))

const authorizeUrl =
  'https://x.com/i/oauth2/authorize?' +
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', REDIRECT_URI)
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return }

  const err = url.searchParams.get('error')
  if (err) {
    res.end(`Authorization failed: ${err}. You can close this tab.`)
    console.error(`\nauthorization failed: ${err}`)
    process.exit(1)
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('State mismatch — try again.')
    return
  }

  const code = url.searchParams.get('code')
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: CLIENT_ID,
  })
  // Confidential clients authenticate with Basic auth; public clients rely on PKCE alone
  if (CLIENT_SECRET) {
    headers.authorization = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  }

  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body })
  const tokens = (await tokenRes.json()) as {
    access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string
  }
  if (!tokenRes.ok || !tokens.access_token) {
    res.end('Token exchange failed — see terminal.')
    console.error('\ntoken exchange failed:', JSON.stringify(tokens, null, 2))
    process.exit(1)
  }

  // Confirm WHICH account authorized — catching a wrong-account OAuth now
  // beats discovering it on the first published tweet.
  const meRes = await fetch('https://api.x.com/2/users/me', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  const me = (await meRes.json()) as { data?: { id: string; username: string; name: string } }

  res.end('Authorized. You can close this tab and return to the terminal.')
  console.log(`\nauthorized as: @${me.data?.username} (${me.data?.name}, id ${me.data?.id})`)
  console.log(`granted scopes: ${tokens.scope}`)

  if (!me.data) {
    console.error('could not resolve the account — tokens NOT saved. Try again.')
    process.exit(1)
  }
  const accounts = saveAccount({
    userId: me.data.id,
    username: me.data.username,
    name: me.data.name,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    scopes: tokens.scope,
    authorizedAt: new Date().toISOString(),
  })
  console.log(`\nsaved to ${accountsPath()} — ${accounts.length} persona account(s):`)
  for (const a of accounts) console.log(`  @${a.username} (${a.name})`)
  console.log('\nNothing to paste anywhere. Re-run this tool (as a different logged-in')
  console.log('account) to add more personas; token rotations save themselves.')
  server.close()
  process.exit(0)
})

server.listen(PORT, () => {
  console.log('1. Make sure the browser you use is logged in as the PERSONA account.')
  console.log('2. Open:\n')
  console.log(authorizeUrl)
  console.log(`\nListening on ${REDIRECT_URI} …`)
})
