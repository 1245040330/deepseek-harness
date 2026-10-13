/** Check this source plugin against the workspace's emitted dependency declarations. */
import ts from '../../node_modules/typescript/lib/typescript.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const base = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), ts.sys.readFile)
if (base.error) throw new Error(ts.flattenDiagnosticMessageText(base.error.messageText, '\n'))
const paths = Object.fromEntries(Object.entries(base.config.compilerOptions.paths).map(([name, targets]) => [name,
  targets.map(target => resolve(root, target.replace(/\/src(?=\/|$)/, '/lib/types').replace(/\.tsx?$/, '.d.ts'))),
]))
const config = ts.parseJsonConfigFileContent({ compilerOptions: {
  ...base.config.compilerOptions, paths, composite: false, incremental: false,
  noEmit: true,
}, files: [fileURLToPath(new URL('./index.ts', import.meta.url))] }, ts.sys, root)
const program = ts.createProgram(config.fileNames, config.options)
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n',
  }))
  process.exitCode = 1
} else process.stdout.write('agent-tool-loader: typecheck passed\n')
