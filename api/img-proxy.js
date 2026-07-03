// Allowlisted domains — only proxy images from known trusted sources
const ALLOWED_HOSTS = [
  'cdn.higgsfield.ai',
  'media.higgsfield.ai',
  'storage.higgsfield.ai',
  'files.higgsfield.ai',
  'oaidalleapiprodscus.blob.core.windows.net',
  'oaidallexprodscus.blob.core.windows.net',
  // Higgsfield's CloudFront distribution for generated media. Pinned to the exact
  // host (not the shared *.cloudfront.net suffix, which anyone can register on) to
  // keep this from becoming an open proxy. If Higgsfield rotates or adds
  // distributions, downloads 403 and the new host id gets added here.
  'd8j0ntlcm91z4.cloudfront.net',
]

export function isSafeUrl(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    return ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))
  } catch { return false }
}

export function safeFilename(name) {
  return (name || 'image.jpg')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128)
}

import { Readable, pipeline } from 'node:stream'
import { rateLimit, clientIp } from '../lib/rateLimit.js'

export default async function handler(req, res) {
  const rl = rateLimit(clientIp(req.headers))
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    res.status(429).send('Too many requests — slow down a moment and try again.'); return
  }

  // req.query values are already percent-decoded by Vercel, so `url` is the real
  // URL — do NOT decodeURIComponent again or signed CDN URLs (literal %2F, %3D in
  // the signature) get corrupted and a stray % throws.
  const { url, name } = req.query
  if (!url) { res.status(400).send('Missing url'); return }
  if (!isSafeUrl(url)) { res.status(403).send('URL not allowed'); return }

  try {
    const upstream = await fetch(url)
    if (!upstream.ok) { res.status(upstream.status).send('Upstream error'); return }

    const ct = upstream.headers.get('content-type') || 'image/jpeg'
    if (!ct.startsWith('image/') && !ct.startsWith('video/')) {
      res.status(400).send('Not an image or video'); return
    }

    res.setHeader('Content-Type', ct)
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(name)}"`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    // Generated media on the allowlisted CDNs is immutable — a URL's content never
    // changes — so cache as long as possible instead of re-proxying every hour.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    // fetch auto-decompresses encoded bodies but reports the COMPRESSED length —
    // forwarding it for an encoded response under-counts and truncates the download.
    const len = upstream.headers.get('content-length')
    if (len && !upstream.headers.get('content-encoding')) res.setHeader('Content-Length', len)

    // Stream instead of buffering — videos run tens of MB and arrayBuffer() held
    // the entire file in function memory before the first byte went out.
    // pipeline (vs pipe) also tears down the upstream stream on client disconnect.
    if (upstream.body) {
      pipeline(Readable.fromWeb(upstream.body), res, () => {})
    } else {
      res.end()
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).send('Proxy error')
    else res.destroy()
  }
}
