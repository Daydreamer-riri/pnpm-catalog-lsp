import { defineConfig } from 'tsup'

export default defineConfig(options => {
  return {
    entry: {
      server: 'src/cli.ts',
    },
    outDir: 'bin',
    format: ['cjs'],
    sourcemap: !options.minify,
    minify: options.minify,
    clean: true,
  }
})
