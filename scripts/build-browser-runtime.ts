/**
 * Bundles the Dynamic Worker harness together with `@cloudflare/playwright` into one ES module that
 * the `BrowserRunner` entrypoint reads from static assets at runtime. Runs before every `vite dev`
 * and `vite build`; the output is generated and ignored by git.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'public', 'browser-runtime')

await mkdir(outDir, { recursive: true })
await build({
  entryPoints: [path.join(root, 'src/plugins/cloudflare-browser-run/runtime/harness.ts')],
  outfile: path.join(outDir, 'runtime.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'esnext',
  minify: true,
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  external: ['cloudflare:*', 'node:*'],
  logLevel: 'warning',
})
const bytes = await readFile(path.join(outDir, 'runtime.js'))
const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ hash, bytes: bytes.byteLength }))
console.log(`browser runtime: ${(bytes.byteLength / 1024).toFixed(0)} KiB, hash ${hash}`)
