/** Verify that the initial UI source copy matches the default packages byte for byte. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const directory = dirname(fileURLToPath(import.meta.url))
function files(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(root, join(dir, entry.name)) : [relative(root, join(dir, entry.name))]).sort()
}
let count = 0
for (const name of ['ui-layout', 'ui-sidebar', 'ui-conversation']) {
  const original = join(directory, '..', name, 'src')
  const copy = join(directory, name, 'src')
  const originals = files(original)
  const copies = files(copy)
  if (JSON.stringify(originals) !== JSON.stringify(copies)) throw new Error(`${name}: copied source file list differs`)
  for (const file of originals) {
    if (!readFileSync(join(original, file)).equals(readFileSync(join(copy, file)))) {
      throw new Error(`${name}/${file}: source differs from default`)
    }
    count++
  }
}
console.log(`UI copy verified: ${count} source files match the defaults`)
