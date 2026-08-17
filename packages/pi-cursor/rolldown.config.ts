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
  // Generated protobuf places /*@__PURE__*/ before `=` (ignored by Rolldown). Keep the
  // check enabled for handwritten code; only suppress INVALID_ANNOTATION under src/proto/.
  onLog(level, log, defaultHandler) {
    if (log.code === 'INVALID_ANNOTATION' && typeof log.id === 'string' && /[/\\]proto[/\\]/.test(log.id)) {
      return
    }
    defaultHandler(level, log)
  },
  external: [
    /^node:/,
    '@earendil-works/pi-coding-agent',
    /^@earendil-works\/pi-ai(?:$|\/(?:compat|oauth|providers\/all)$)/,
  ],
})
