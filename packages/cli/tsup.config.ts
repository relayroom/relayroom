import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  banner: { js: '#!/usr/bin/env node' },
  // Bake the package version so `relayroom --version` matches what was published.
  define: { __CLI_VERSION__: JSON.stringify(version) },
  clean: true,
})
