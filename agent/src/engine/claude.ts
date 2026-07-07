// Minimal Anthropic Messages client — injectable for tests, deliberately not
// the SDK: the agent makes one kind of call.
//
// SOCKS egress: Anthropic region-blocks AUTHENTICATED calls from some egress
// IPs with 403 "Request not allowed" (same failure vite.config.js documents
// for the dev server). The owner's `us-on` tunnel is a SOCKS proxy that Node
// ignores (system proxies don't apply to Node), so when a proxy URL is
// given we route through node:https + SocksProxyAgent — fetch can't carry a
// SOCKS agent. Irrelevant on Hetzner, where egress isn't region-blocked.
import { request, type Agent } from 'node:https'
import { SocksProxyAgent } from 'socks-proxy-agent'

export interface ClaudeClient {
  complete(p: { system?: string; user: string; maxTokens?: number }): Promise<string>
}

export class ClaudeApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message)
    this.name = 'ClaudeApiError'
  }
}

function httpsPost(
  url: string, headers: Record<string, string>, body: string, agent?: Agent
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, agent }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => req.destroy(new Error('Claude upstream timeout')))
    req.end(body)
  })
}

export function createClaudeClient(opts: {
  apiKey: string
  model?: string
  /** e.g. socks5h://127.0.0.1:10808 — routes around Anthropic's egress geo-block */
  socksProxyUrl?: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}): ClaudeClient {
  const model = opts.model ?? 'claude-sonnet-5'
  const doFetch = opts.fetchImpl ?? fetch
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com'
  const agent = opts.socksProxyUrl ? new SocksProxyAgent(opts.socksProxyUrl) : undefined

  return {
    async complete({ system, user, maxTokens = 1000 }) {
      const payload: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: user }],
      }
      if (system) payload.system = system
      const body = JSON.stringify(payload)
      const headers = {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }

      let status: number
      let text: string
      if (agent) {
        ;({ status, text } = await httpsPost(`${baseUrl}/v1/messages`, {
          ...headers, 'content-length': String(Buffer.byteLength(body)),
        }, body, agent))
      } else {
        const res = await doFetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body })
        status = res.status
        text = await res.text()
      }

      if (status < 200 || status >= 300) {
        const hint = status === 403 && !agent
          ? ' — likely the egress geo-block; run `us-on` (the agent auto-detects the SOCKS tunnel on restart)'
          : ''
        throw new ClaudeApiError(`Claude API ${status}${hint}`, status, text)
      }
      const data = JSON.parse(text) as { content?: { type: string; text?: string }[] }
      return (data.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
        .trim()
    },
  }
}
