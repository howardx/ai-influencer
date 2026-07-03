import { Readable, pipeline } from 'node:stream'
import { defineConfig } from 'vite'
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
        }
        if (req.headers['anthropic-beta']) upstreamHeaders['anthropic-beta'] = req.headers['anthropic-beta']
        const upstream = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: upstreamHeaders, body })
        const data = await upstream.json()
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: e.message } }))
      }
    })
  },
}

export default defineConfig({
  plugins: [react(), searchPlugin, imgProxyPlugin, claudePlugin],
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
