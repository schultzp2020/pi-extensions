/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- JavaScript fixture is outside the TypeScript project. */
import { createServer } from 'node:http'

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/internal/health') {
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (req.url === '/internal/models') {
    res.end(JSON.stringify({ models: [] }))
    return
  }
  if (req.url === '/internal/heartbeat' || req.url === '/internal/token') {
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(
      `data: ${JSON.stringify({
        id: 'fixture-recovery',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'cursor-test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: `served-by:${String(process.pid)}:${String(port)}` },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({
        id: 'fixture-recovery',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'cursor-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
    return
  }
  if (req.url === '/test/disconnect') {
    res.end(JSON.stringify({ ok: true }))
    setInterval(() => {}, 1_000)
    server.close()
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  console.log(JSON.stringify({ type: 'ready', port, models: [] }))
})
