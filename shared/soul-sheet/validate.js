// Shared soul-sheet validation — imported by BOTH the app (Personality editor)
// and the agent (soul-sheet loader), so a sheet that passes in the editor is
// guaranteed loadable on the agent. schema.json is the source of truth; this
// module only adds the semantic rules JSON Schema cannot express. Any
// non-JS consumer (spec §4 rewrite path) must port these three checks too.
import Ajv from 'ajv'
import schema from './schema.json'

const ajv = new Ajv({ allErrors: true })
const validateAgainstSchema = ajv.compile(schema)

const WEIGHT_SUM_TOLERANCE = 0.001

/**
 * Validate a parsed soul sheet object.
 * @param {any} sheet
 * @returns {{ valid: boolean, errors: string[] }} errors are human-readable,
 *   suitable for direct display in the editor UI or agent startup logs.
 */
export function validateSoulSheet(sheet) {
  if (!validateAgainstSchema(sheet)) {
    const errors = (validateAgainstSchema.errors || []).map(
      e => `${e.instancePath || '(root)'} ${e.message}`
    )
    return { valid: false, errors }
  }

  const errors = []

  const weightSum = sheet.contentPillars.reduce((sum, p) => sum + p.weight, 0)
  if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    errors.push(`contentPillars weights must sum to 1 (got ${weightSum.toFixed(3)})`)
  }

  const names = sheet.contentPillars.map(p => p.name)
  if (new Set(names).size !== names.length) {
    errors.push('contentPillars names must be unique')
  }

  const [min, max] = sheet.rhythm.postsPerDay
  if (min > max) {
    errors.push(`rhythm.postsPerDay must be [min, max] with min <= max (got [${min}, ${max}])`)
  }

  return { valid: errors.length === 0, errors }
}

/** Parse + validate a soul sheet from a JSON string (editor import, agent file load). */
export function parseSoulSheet(json) {
  let sheet
  try {
    sheet = JSON.parse(json)
  } catch (e) {
    return { valid: false, sheet: null, errors: [`not valid JSON: ${e.message}`] }
  }
  const { valid, errors } = validateSoulSheet(sheet)
  return { valid, sheet: valid ? sheet : null, errors }
}
