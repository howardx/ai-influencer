import { describe, it, expect } from 'vitest'
import { isSafeUrl, safeFilename } from './img-proxy.js'

describe('isSafeUrl', () => {
  it('allows https URLs on allowlisted hosts', () => {
    expect(isSafeUrl('https://cdn.higgsfield.ai/image.png')).toBe(true)
    expect(isSafeUrl('https://d8j0ntlcm91z4.cloudfront.net/media/clip.mp4')).toBe(true)
    expect(isSafeUrl('https://oaidalleapiprodscus.blob.core.windows.net/x.jpg?sig=a%2Fb%3D')).toBe(true)
  })

  it('allows subdomains of allowlisted hosts', () => {
    expect(isSafeUrl('https://eu.cdn.higgsfield.ai/image.png')).toBe(true)
  })

  it('rejects plain http even on an allowlisted host', () => {
    expect(isSafeUrl('http://cdn.higgsfield.ai/image.png')).toBe(false)
  })

  it('rejects non-allowlisted hosts', () => {
    expect(isSafeUrl('https://evil.example.com/image.png')).toBe(false)
    expect(isSafeUrl('https://cloudfront.net/anyone-can-register-here.png')).toBe(false)
  })

  it('rejects hosts that merely embed an allowlisted name', () => {
    // suffix attack: allowlisted host as a subdomain of the attacker's domain
    expect(isSafeUrl('https://cdn.higgsfield.ai.evil.com/image.png')).toBe(false)
    // prefix attack: no dot boundary before the allowlisted name
    expect(isSafeUrl('https://evilcdn.higgsfield.ai/image.png')).toBe(false)
  })

  it('rejects userinfo tricks where the allowlisted host is only the username', () => {
    expect(isSafeUrl('https://cdn.higgsfield.ai@evil.com/image.png')).toBe(false)
  })

  it('rejects non-http(s) protocols and unparseable input', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeUrl('ftp://cdn.higgsfield.ai/x')).toBe(false)
    expect(isSafeUrl('not a url at all')).toBe(false)
    expect(isSafeUrl('')).toBe(false)
  })
})

describe('safeFilename', () => {
  it('passes a clean filename through unchanged', () => {
    expect(safeFilename('kayla_post-01.jpg')).toBe('kayla_post-01.jpg')
  })

  it('replaces unsafe characters with underscores', () => {
    expect(safeFilename('my photo (final).jpg')).toBe('my_photo__final_.jpg')
  })

  it('neutralizes path separators and traversal sequences', () => {
    const out = safeFilename('../../etc/passwd')
    expect(out).not.toContain('/')
    expect(out).toMatch(/^[a-zA-Z0-9._-]+$/)
  })

  it('strips quotes so the Content-Disposition header cannot be broken out of', () => {
    expect(safeFilename('a"; filename="evil.exe')).not.toContain('"')
  })

  it('defaults to image.jpg for missing or empty names', () => {
    expect(safeFilename()).toBe('image.jpg')
    expect(safeFilename('')).toBe('image.jpg')
    expect(safeFilename(null)).toBe('image.jpg')
  })

  it('truncates to 128 characters', () => {
    expect(safeFilename('x'.repeat(500))).toHaveLength(128)
  })
})

// ── Handler streaming behavior ──────────────────────────────────────
import { describe as describe2, it as it2, expect as expect2, vi, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import handler from './img-proxy.js'

function makeRes() {
  const res = new PassThrough()
  const chunks = []
  res.on('data', c => chunks.push(c))
  res.headers = {}
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
  res.statusCode = 200
  res.status = c => { res.statusCode = c; return res }
  res.send = body => { res.sentBody = body; res.end() }
  res.bodyText = () => Buffer.concat(chunks).toString()
  res.done = new Promise(r => res.on('finish', r))
  return res
}

describe2('img-proxy handler', () => {
  afterEach(() => vi.unstubAllGlobals())

  it2('streams the upstream body with long-lived immutable caching', async () => {
    const payload = 'jpeg-bytes-'.repeat(100)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(payload, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(payload.length) } })
    ))
    const res = makeRes()
    await handler({ headers: {}, query: { url: 'https://cdn.higgsfield.ai/gen/a.jpg', name: 'a.jpg' } }, res)
    await res.done
    expect2(res.bodyText()).toBe(payload)
    expect2(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect2(res.headers['content-type']).toBe('image/jpeg')
    expect2(res.headers['content-disposition']).toContain('a.jpg')
  })

  it2('does not forward Content-Length for content-encoded upstreams', async () => {
    // fetch decompresses the body but the header reports the COMPRESSED length —
    // forwarding it would truncate the client download.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('decompressed-bytes', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '10', 'content-encoding': 'gzip' } })
    ))
    const res = makeRes()
    await handler({ headers: {}, query: { url: 'https://cdn.higgsfield.ai/b.png', name: 'b.png' } }, res)
    await res.done
    expect2(res.headers['content-length']).toBeUndefined()
    expect2(res.bodyText()).toBe('decompressed-bytes')
  })

  it2('propagates upstream errors without streaming', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const res = makeRes()
    await handler({ headers: {}, query: { url: 'https://cdn.higgsfield.ai/gone.jpg', name: 'x.jpg' } }, res)
    expect2(res.statusCode).toBe(404)
    expect2(res.sentBody).toBe('Upstream error')
  })
})
