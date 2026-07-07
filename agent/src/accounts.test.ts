import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccounts, saveAccount, updateTokens, resolveAccount, type StoredAccount } from './accounts'

const kayla: StoredAccount = {
  userId: 'u1', username: 'kaylaliftsworld', name: 'Kayla',
  accessToken: 'at-1', refreshToken: 'rt-1', authorizedAt: '2026-07-07T00:00:00.000Z',
}
const zoe: StoredAccount = {
  userId: 'u2', username: 'zoe_runs', name: 'Zoe',
  accessToken: 'at-2', authorizedAt: '2026-07-07T00:00:00.000Z',
}

describe('accounts store', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'accounts-test-'))
    path = join(dir, 'accounts.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts empty and round-trips accounts', () => {
    expect(loadAccounts(path)).toEqual([])
    saveAccount(kayla, path)
    saveAccount(zoe, path)
    expect(loadAccounts(path).map(a => a.username)).toEqual(['kaylaliftsworld', 'zoe_runs'])
  })

  it('upserts by userId (re-auth replaces, never duplicates)', () => {
    saveAccount(kayla, path)
    saveAccount({ ...kayla, accessToken: 'at-new' }, path)
    const accounts = loadAccounts(path)
    expect(accounts).toHaveLength(1)
    expect(accounts[0].accessToken).toBe('at-new')
  })

  it('persists rotated tokens and keeps the old refresh token if none given', () => {
    saveAccount(kayla, path)
    updateTokens('u1', { accessToken: 'at-rotated' }, path)
    expect(loadAccounts(path)[0]).toMatchObject({ accessToken: 'at-rotated', refreshToken: 'rt-1' })
    updateTokens('u1', { accessToken: 'at-3', refreshToken: 'rt-3' }, path)
    expect(loadAccounts(path)[0]).toMatchObject({ accessToken: 'at-3', refreshToken: 'rt-3' })
  })

  it('writes the file owner-read-only (secrets on disk)', () => {
    saveAccount(kayla, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('resolves explicit handle case-insensitively, errors on unknown', () => {
    const accounts = [kayla, zoe]
    expect(resolveAccount(accounts, 'KaylaLiftsWorld').account?.userId).toBe('u1')
    expect(resolveAccount(accounts, 'nobody').error).toMatch(/no stored account/)
  })

  it('auto-picks a sole account, demands a choice among several', () => {
    expect(resolveAccount([kayla]).account?.userId).toBe('u1')
    expect(resolveAccount([kayla, zoe]).needsChoice).toBe(true)
    expect(resolveAccount([]).error).toMatch(/no authorized accounts/)
  })
})
