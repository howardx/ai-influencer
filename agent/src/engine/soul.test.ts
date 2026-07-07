import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSoulSheet, SoulSheetError } from './soul'

const KAYLA_PATH = fileURLToPath(
  new URL('../../../shared/soul-sheet/kayla.example.json', import.meta.url)
)

describe('loadSoulSheet', () => {
  it('loads the shared Kayla example (agent validates the same file the app edits)', () => {
    const sheet = loadSoulSheet(KAYLA_PATH)
    expect(sheet.identity.name).toBe('Kayla')
    expect(sheet.contentPillars.map(p => p.name)).toContain('trend opinion')
    expect(sheet.boundaries.disclosure).toMatch(/AI character/)
  })

  it('throws SoulSheetError with readable problems for an invalid sheet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soul-test-'))
    try {
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, JSON.stringify({ schemaVersion: 1 }))
      expect(() => loadSoulSheet(bad)).toThrow(SoulSheetError)
      expect(() => loadSoulSheet(bad)).toThrow(/personaId/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws a readable error for a missing file', () => {
    expect(() => loadSoulSheet('/nope/missing.json')).toThrow(/cannot read file/)
  })
})
