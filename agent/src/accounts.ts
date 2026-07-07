// Persona account store: one entry per X account that has authorized the
// app, written by tools/x-oauth.ts and consumed by tools + engine. This is
// the "N personas, one app" surface — the client ID/secret stay in env
// (app-level), while per-persona tokens live here as data (tenancy rule:
// credentials are constructor data, never globals).
//
// The file lives under the data dir (gitignored; mode 600) — same trust
// domain as the SQLite DB it sits next to.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface StoredAccount {
  /** X user id — stable even if the handle is renamed */
  userId: string
  username: string
  name: string
  accessToken: string
  refreshToken?: string
  scopes?: string
  authorizedAt: string
}

export function accountsPath(dataDir: string = process.env.AGENT_DATA_DIR || './data'): string {
  return join(dataDir, 'accounts.json')
}

export function loadAccounts(path: string = accountsPath()): StoredAccount[] {
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { accounts?: StoredAccount[] }
  return parsed.accounts ?? []
}

/** Insert or update (by userId) one account. Returns the full list. */
export function saveAccount(account: StoredAccount, path: string = accountsPath()): StoredAccount[] {
  const accounts = loadAccounts(path)
  const i = accounts.findIndex(a => a.userId === account.userId)
  if (i === -1) accounts.push(account)
  else accounts[i] = { ...accounts[i], ...account }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ accounts }, null, 2) + '\n')
  chmodSync(path, 0o600)
  return accounts
}

/** Persist rotated tokens for an account (refresh tokens rotate on every use). */
export function updateTokens(
  userId: string,
  tokens: { accessToken: string; refreshToken?: string },
  path: string = accountsPath()
): void {
  const accounts = loadAccounts(path)
  const account = accounts.find(a => a.userId === userId)
  if (!account) return
  account.accessToken = tokens.accessToken
  if (tokens.refreshToken) account.refreshToken = tokens.refreshToken
  writeFileSync(path, JSON.stringify({ accounts }, null, 2) + '\n')
  chmodSync(path, 0o600)
}

/**
 * Resolve which persona to act as: an explicit handle wins; a single stored
 * account is unambiguous; otherwise the caller must prompt.
 */
export function resolveAccount(
  accounts: StoredAccount[],
  handle?: string
): { account?: StoredAccount; needsChoice: boolean; error?: string } {
  if (handle) {
    const account = accounts.find(a => a.username.toLowerCase() === handle.toLowerCase())
    return account
      ? { account, needsChoice: false }
      : { needsChoice: false, error: `no stored account @${handle} — authorize it first with tools/x-oauth.ts` }
  }
  if (accounts.length === 0) {
    return { needsChoice: false, error: 'no authorized accounts yet — run tools/x-oauth.ts first' }
  }
  if (accounts.length === 1) return { account: accounts[0], needsChoice: false }
  return { needsChoice: true }
}
