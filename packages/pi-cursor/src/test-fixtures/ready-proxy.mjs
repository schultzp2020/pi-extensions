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
