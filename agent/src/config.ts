// Process configuration. Secrets live ONLY in env / secret files on Hetzner
// (systemd EnvironmentFile) or a local .env passed via `tsx --env-file` —
// never in the repo, never in the browser app (spec §4 trust boundary).
//
// Note the split: env holds process-level settings and raw secret material;
// adapters still receive credentials as constructor data (tenancy rule), so
// multi-persona configs later just parse more env/file entries into more
// constructor calls — no global-credential assumptions to unwind.

export interface AgentConfig {
  /** Directory for SQLite files and the media library. */
  dataDir: string
  /** Path to the soul sheet JSON for the (single, for now) persona. */
  soulSheetPath: string
  /** Present only when the corresponding integration is configured. */
  telegramBotToken?: string
  anthropicApiKey?: string
  /**
   * App-level X credentials only. Per-persona access/refresh tokens live in
   * the accounts store (data/accounts.json), NOT in env — tokens rotate and
   * env is static.
   */
  x?: {
    clientId: string
    clientSecret?: string
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    dataDir: env.AGENT_DATA_DIR || './data',
    soulSheetPath: env.SOUL_SHEET || '../shared/soul-sheet/kayla.example.json',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    x: env.X_CLIENT_ID
      ? {
          clientId: env.X_CLIENT_ID,
          clientSecret: env.X_CLIENT_SECRET || undefined,
        }
      : undefined,
  }
}
