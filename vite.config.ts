import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'
import { builtinModules } from 'module'
import pkg from './package.json'

// Externalise runtime dependencies and Node built-ins instead of bundling them.
// pgsql-parser pulls in libpg-query, whose loader reads `libpg-query.wasm` from
// its own package directory via `readFileSync(__dirname + '/libpg-query.wasm')`.
// Bundling it into this dist breaks that lookup (the .wasm never lands next to
// our output), which is why the parser failed under Node. Keeping these external
// lets the consumer's Node resolve pgsql-parser from node_modules, where the WASM
// sits beside the loader, producing a Node-safe build.
const externalPackages = [...Object.keys(pkg.dependencies ?? {})]
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]
const isExternal = (id: string): boolean =>
  nodeBuiltins.includes(id) ||
  externalPackages.some((p) => id === p || id.startsWith(`${p}/`))

export default defineConfig({
  build: {
    target: 'node24',
    lib: {
      // Two public entries: the parser-free model (`index`) and the WASM-bearing
      // SQL parser (`parser`). Rollup hoists the shared model code into a common
      // chunk imported by both, so model-only consumers of `index` never pull in
      // anything reachable solely from `parser` (pgsql-parser / libpg-query WASM).
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        parser: resolve(__dirname, 'src/parser.ts'),
      },
      fileName: (format, entryName) => format === 'es' ? `${entryName}.js` : `${entryName}.cjs`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: isExternal,
      output: {
        // Emit `require`-based dynamic imports in the CJS bundle instead of a
        // native `import()`. pgParser.ts lazily `import('pgsql-parser')`; a real
        // `import()` works in production Node but throws under a CommonJS VM
        // (e.g. Jest without --experimental-vm-modules). pgsql-parser ships a CJS
        // entry, so require-based interop is safe and keeps CJS consumers working.
        dynamicImportInCjs: false,
      },
    },
    sourcemap: true,
  },
  plugins: [
    dts({
      include: ['src/**/*'],
      insertTypesEntry: true,
    }),
  ],
})
