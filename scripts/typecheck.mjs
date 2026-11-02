// Typecheck via the TypeScript API instead of the `tsc` bin wrapper: the bin
// shim (node_modules/typescript/lib/_tsc.js) is a 9 MB generated file, and it
// adds nothing we need here. Prints diagnostics in the same shape tsc does and
// exits non-zero when there are errors.
import ts from 'typescript'

const configPath = 'tsconfig.json'

const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error) {
  console.error(ts.formatDiagnostic(configFile.error, formatHost()))
  process.exit(2)
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd())
if (parsed.errors.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost()))
  process.exit(2)
}

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
const diagnostics = ts.getPreEmitDiagnostics(program)

if (diagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost()))
  const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length
  console.error(`\n[typecheck] ${errors} error(s), ${diagnostics.length - errors} other diagnostic(s)`)
  process.exit(1)
}

console.log(`[typecheck] clean — ${parsed.fileNames.length} file(s), target ${String(parsed.options.target)}`)

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }
}
