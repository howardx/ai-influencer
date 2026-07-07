import { Readable, pipeline } from 'node:stream'
import net from 'node:net'
import https from 'node:https'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
// Reuse the production guard so the dev mirror can't drift from it (an unguarded
// dev proxy is an open SSRF against the developer's machine/network).
import { isSafeUrl, safeFilename } from './api/img-proxy.js'

// Local dev search proxy — mirrors api/search.js for Vercel production
const searchPlugin = {
  name: 'search-proxy',
  configureServer(server) {
    server.middlewares.use('/api/search', async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

      const q = new URLSearchParams(req.url.split('?')[1] || '').get('q')
      if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing q' })); return }

      try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        })
        const xml = await r.text()
        const items = []
        for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const block = match[1]
          const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>/)?.[1] || block.match(/<title>(.*?)<\/title>/)?.[1] || '').trim()
          const desc = (block.match(/<description><!\[CDATA\[(.*?)\]\]>/)?.[1] || block.match(/<description>(.*?)<\/description>/)?.[1] || '')
            .replace(/<[^>]+>/g, '').trim().slice(0, 300)
          const date = (block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '').trim()
          if (title) items.push({ title, description: desc, date })
          if (items.length >= 8) break
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ items }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message, items: [] }))
      }
    })
  },
}

// Local dev image proxy — mirrors api/img-proxy.js for Vercel production
const imgProxyPlugin = {
  name: 'img-proxy',
  configureServer(server) {
    server.middlewares.use('/api/img-proxy', async (req, res) => {
      const qs = new URLSearchParams(req.url.split('?')[1] || '')
      // URLSearchParams.get already percent-decodes — don't decode again (matches prod).
      const url = qs.get('url')
      const name = qs.get('name') || 'image.jpg'
      if (!url) { res.writeHead(400); res.end('Missing url'); return }
      if (!isSafeUrl(url)) { res.writeHead(403); res.end('URL not allowed'); return }
      try {
        const r = await fetch(url)
        const ct = r.headers.get('content-type') || 'image/jpeg'
        if (!ct.startsWith('image/') && !ct.startsWith('video/')) {
          res.writeHead(400); res.end('Not an image or video'); return
        }
        // Stream, matching prod (api/img-proxy.js) — no whole-file buffering
        res.writeHead(r.status, {
          'Content-Type': ct,
          'Content-Disposition': `attachment; filename="${safeFilename(name)}"`,
          'Access-Control-Allow-Origin': '*',
        })
        if (r.body) {
          // pipeline tears down the upstream stream if the browser disconnects —
          // matters here because the dev server is long-lived
          pipeline(Readable.fromWeb(r.body), res, () => {})
        } else {
          res.end()
        }
      } catch (e) {
        if (!res.headersSent) { res.writeHead(500); res.end('Proxy error: ' + e.message) }
        else res.destroy()
      }
    })
  },
}

// ── Dev-only US egress for the Claude upstream ────────────────────────────
// Anthropic region-blocks AUTHENTICATED API calls from some egress IPs with
// 403 "Request not allowed" — keyless probes still get 401 (auth is checked
// first), which makes this easy to misdiagnose as a bad key. The developer's
// US routing (`us-on` in ~/.zshrc) is an xray SOCKS proxy on 127.0.0.1:10808
// set as the macOS SYSTEM proxy — browsers honor that, but Node ignores
// system proxies (and HTTP_PROXY) entirely, so the dev server's upstream
// fetch used to bypass the tunnel and 403 while the same key returned 200
// from the browser. Probe the SOCKS port (cached 60s) and route the Claude
// upstream through it when up; fall back to direct when `us-off`.
// Production is unaffected: this file never ships — api/claude.js runs on
// Vercel with US egress (region pinned in vercel.json).
const SOCKS_HOST = '127.0.0.1'
const SOCKS_PORT = 10808
let _socksCheck = { at: 0, up: false }
function socksProxyUp() {
  return new Promise(resolve => {
    if (Date.now() - _socksCheck.at < 60_000) return resolve(_socksCheck.up)
    const sock = net.connect({ host: SOCKS_HOST, port: SOCKS_PORT, timeout: 250 })
    const done = up => { _socksCheck = { at: Date.now(), up }; sock.destroy(); resolve(up) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.once('timeout', () => done(false))
  })
}
let _socksAgent = null
function socksAgent() {
  if (!_socksAgent) _socksAgent = new SocksProxyAgent(`socks5h://${SOCKS_HOST}:${SOCKS_PORT}`)
  return _socksAgent
}

// node fetch can't take a SOCKS agent — plain https.request can
function claudeUpstream({ headers, body, agent }) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', { method: 'POST', headers, agent }, resp => {
      let data = ''
      resp.on('data', c => { data += c })
      resp.on('end', () => resolve({ status: resp.statusCode, text: data }))
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => req.destroy(new Error('Claude upstream timeout')))
    req.end(body)
  })
}

// Local dev Claude proxy — mirrors api/claude.js for Vercel production
const claudePlugin = {
  name: 'claude-proxy',
  configureServer(server) {
    server.middlewares.use('/api/claude', async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, anthropic-beta')
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return }
      const apiKey = req.headers['x-api-key']
      if (!apiKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Missing x-api-key' } })); return }
      const chunks = []
      req.on('data', c => chunks.push(c))
      await new Promise(r => req.on('end', r))
      const body = Buffer.concat(chunks).toString()
      try {
        const upstreamHeaders = {
          'x-api-key': apiKey,
          'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        }
        if (req.headers['anthropic-beta']) upstreamHeaders['anthropic-beta'] = req.headers['anthropic-beta']
        const viaSocks = await socksProxyUp()
        const { status, text } = await claudeUpstream({
          headers: upstreamHeaders,
          body,
          agent: viaSocks ? socksAgent() : undefined,
        })
        let payload = text
        if (status === 403 && !viaSocks) {
          // Direct egress got region-blocked and the tunnel is down — say so
          // instead of letting it read like a bad API key.
          try {
            const j = JSON.parse(text)
            if (j?.error) {
              j.error.message = `${j.error.message} — dev-server egress is not US and the local SOCKS tunnel (127.0.0.1:${SOCKS_PORT}) is down. Run 'us-on' and retry.`
              payload = JSON.stringify(j)
            }
          } catch {}
        }
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(payload)
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: e.message } }))
      }
    })
  },
}

// Local dev GLM proxy — mirrors api/glm.js for Vercel production. GLM has no
// region block, so no SOCKS routing is needed; plain fetch is enough.
const GLM_UPSTREAMS = {
  zai: 'https://api.z.ai/api/paas/v4/chat/completions',
  // Coding Plan keys only work on the dedicated coding endpoint (the general
  // one answers 429 code 1113 "Insufficient balance" for them).
  'zai-coding': 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  bigmodel: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
}
const glmPlugin = {
  name: 'glm-proxy',
  configureServer(server) {
    server.middlewares.use('/api/glm', async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-ai-platform')
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return }
      const apiKey = req.headers['x-api-key']
      if (!apiKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Missing x-api-key' } })); return }
      const chunks = []
      req.on('data', c => chunks.push(c))
      await new Promise(r => req.on('end', r))
      const body = Buffer.concat(chunks).toString()
      try {
        const upstream = await fetch(GLM_UPSTREAMS[req.headers['x-ai-platform']] || GLM_UPSTREAMS.zai, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body,
        })
        const text = await upstream.text()
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
        res.end(text)
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: e.message } }))
      }
    })
  },
}

export default defineConfig({
  plugins: [react(), searchPlugin, imgProxyPlugin, claudePlugin, glmPlugin],
  test: {
    // agent/ is its own workspace with its own vitest suite (run by the
    // pre-commit hook separately) — keep its TS tests out of the root run
    exclude: [...configDefaults.exclude, 'agent/**'],
  },
  server: {
    proxy: {
      '/api/hf': {
        target: 'https://mcp.higgsfield.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/hf/, ''),
      },
    },
  },
})
