import { describe, it, expect } from 'vitest'
import handler from './hfproxy.js'

// These tests only exercise paths that return before the upstream fetch
// (allowlist rejection and the CORS preflight), so no network is involved.

const request = (hfpath, { method = 'OPTIONS', headers = {} } = {}) => {
  const url = new URL('https://app.example.com/api/hfproxy')
  if (hfpath !== undefined) url.searchParams.set('__hfpath', hfpath)
  return new Request(url, { method, headers })
}

describe('hfproxy path allowlist', () => {
  it('404s when the path is not on the allowlist, before anything else runs', async () => {
    const res = await handler(request('admin/secrets', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  it('404s when __hfpath is missing entirely', async () => {
    const res = await handler(request(undefined, { method: 'GET' }))
    expect(res.status).toBe(404)
  })

  it('accepts the known Higgsfield MCP prefixes', async () => {
    for (const path of ['mcp', 'oauth2/token', 'v1/jobs/123']) {
      const res = await handler(request(path))
      expect(res.status, path).toBe(204)
    }
  })

  it('normalizes leading slashes so //mcp still matches the allowlist', async () => {
    const res = await handler(request('///mcp'))
    expect(res.status).toBe(204)
  })

  it('does not let a path dodge the allowlist by omitting the prefix slash', async () => {
    // '/' is prepended by the handler; 'v1x/whatever' must not match '/v1/'
    const res = await handler(request('v1x/whatever'))
    expect(res.status).toBe(404)
  })
})

describe('hfproxy CORS preflight', () => {
  it('answers OPTIONS with 204 and echoes the origin', async () => {
    const res = await handler(request('mcp', { headers: { origin: 'http://localhost:5173' } }))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('access-control-allow-headers')).toContain('mcp-session-id')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })
})
