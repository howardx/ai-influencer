// Minimal Anthropic Messages client — fetch-based, injectable for tests.
// Deliberately not the SDK: the agent makes one kind of call, and the fewer
// dependencies on Hetzner the better. Key arrives as constructor data.

export interface ClaudeClient {
  complete(p: { system?: string; user: string; maxTokens?: number }): Promise<string>
}

export class ClaudeApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message)
    this.name = 'ClaudeApiError'
  }
}

export function createClaudeClient(opts: {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}): ClaudeClient {
  const model = opts.model ?? 'claude-sonnet-5'
  const doFetch = opts.fetchImpl ?? fetch
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com'

  return {
    async complete({ system, user, maxTokens = 1000 }) {
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: user }],
      }
      if (system) body.system = system

      const res = await doFetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) throw new ClaudeApiError(`Claude API ${res.status}`, res.status, text)
      const data = JSON.parse(text) as { content?: { type: string; text?: string }[] }
      return (data.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
        .trim()
    },
  }
}
