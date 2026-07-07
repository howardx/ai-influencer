// Persona agent entry point. The engine loop (mixer → draft → critic →
// schedule) lands with HEX-23; until then this is a verifiable smoke run:
// load + validate the soul sheet, open the SQLite DB (WAL), seed arc state,
// and dry-run one publish through DemoAdapter. No secrets required.
//
//   npm run smoke          # from agent/
import { join } from 'node:path'
import { loadConfig } from './config'
import { loadSoulSheet } from './engine/soul'
import { openDb, getArcState, setArcState } from './storage/db'
import { DemoAdapter } from './adapters/demo'

async function main(): Promise<void> {
  const config = loadConfig()
  const sheet = loadSoulSheet(config.soulSheetPath)
  const tenant = { personaId: sheet.personaId, ownerId: sheet.ownerId }
  console.log(`soul sheet ok: ${sheet.identity.name} (${sheet.personaId}), ` +
    `${sheet.contentPillars.length} pillars, ${sheet.voice.examplePosts.length} voice anchors`)

  const db = openDb(join(config.dataDir, `${sheet.personaId}.db`))
  console.log(`db ok: WAL=${db.pragma('journal_mode', { simple: true })}`)

  // Seed arc state once; after that the agent's memory owns it (spec §5)
  if (!getArcState(db, tenant) && sheet.seedArc) {
    setArcState(db, tenant, {
      currentArc: sheet.seedArc.currentArc ?? '',
      runningBits: sheet.seedArc.runningBits ?? [],
      updatedAt: new Date().toISOString(),
    })
    console.log('arc state seeded from soul sheet')
  }

  if (process.argv.includes('--smoke')) {
    const demo = new DemoAdapter()
    await demo.publishPost({
      text: sheet.voice.examplePosts[0],
      idempotencyKey: 'smoke-1',
    })
    console.log(`smoke ok: ${demo.published.length} dry-run publish, nothing left the machine`)
    db.close()
    return
  }

  console.log('engine loop not implemented yet (HEX-23) — run with --smoke or npm run smoke')
  db.close()
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
