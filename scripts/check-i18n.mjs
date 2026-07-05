// Verify every locale has exactly the keys en.json has — missing keys render
// as raw key names in the UI, extras are dead weight.
import { readFileSync } from 'node:fs'

const langs = ['en', 'si', 'de', 'fr', 'es', 'sv']
const sets = Object.fromEntries(
  langs.map((l) => [l, JSON.parse(readFileSync(`src/i18n/${l}.json`, 'utf8'))]),
)
const enKeys = new Set(Object.keys(sets.en))
let bad = 0
for (const l of langs.slice(1)) {
  const keys = new Set(Object.keys(sets[l]))
  const missing = [...enKeys].filter((k) => !keys.has(k))
  const extra = [...keys].filter((k) => !enKeys.has(k))
  if (missing.length || extra.length) {
    bad++
    console.log(`${l}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`)
  } else {
    console.log(`${l}: ok (${keys.size} keys)`)
  }
}
// empty values
for (const l of langs) {
  const empty = Object.entries(sets[l]).filter(([, v]) => !String(v).trim())
  if (empty.length) {
    bad++
    console.log(`${l}: EMPTY values: ${empty.map(([k]) => k).join(', ')}`)
  }
}
console.log(bad ? 'I18N PROBLEMS FOUND' : `ALL LOCALES CONSISTENT (${enKeys.size} keys)`)
process.exitCode = bad ? 1 : 0
