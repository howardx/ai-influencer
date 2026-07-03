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
