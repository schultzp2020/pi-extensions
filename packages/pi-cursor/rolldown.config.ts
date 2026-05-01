import { defineConfig } from 'rolldown'

export default defineConfig({
  input: {
    index: 'src/index.ts',
    'proxy/main': 'src/proxy/main.ts',
  },
  output: {
    dir: 'dist',
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
  platform: 'node',
  treeshake: true,
  external: [/^node:/, '@mariozechner/pi-coding-agent', '@mariozechner/pi-ai'],
})
