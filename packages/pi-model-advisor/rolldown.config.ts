import { defineConfig } from 'rolldown'

export default defineConfig({
  input: {
    index: 'src/index.ts',
  },
  output: {
    dir: 'dist',
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
  platform: 'node',
  treeshake: true,
  external: [/^node:/, /^@earendil-works\/(?:pi-agent-core|pi-ai|pi-coding-agent|pi-tui)(?:$|\/)/, /^typebox(?:$|\/)/],
})
