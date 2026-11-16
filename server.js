// One Render Web Service: serves the built editor AND proxies Kilo on the same origin.
// Same origin => the browser never makes a CORS request.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('./', import.meta.url))
const DIST = join(ROOT, 'dist')
const UPSTREAM = 'https://ai-gateway.kilo.ai/api/v1'
const PORT = Number(process.env.PORT || 10000)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS'
}

function sendIndex(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  createReadStream(join(DIST, 'index.html')).pipe(res)
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/ready') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('ok')
  }

  // Kilo proxy — same origin as the editor.
  if (url.pathname.startsWith('/kilo/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }
    const headers = {}
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
    if (req.headers.authorization) headers.authorization = req.headers.authorization
    try {
      const target = UPSTREAM + url.pathname.slice('/kilo'.length) + url.search
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body
      })
      res.writeHead(upstream.status, {
        ...CORS,
        'content-type': upstream.headers.get('content-type') || 'application/json'
      })
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
      else res.end()
    } catch (error) {
      res.writeHead(502, CORS)
      res.end(JSON.stringify({ error: String(error) }))
    }
    return
  }

  // Static files, with SPA fallback to index.html.
  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(DIST)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const stat = await fs.stat(file)
    if (stat.isFile()) {
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
      return createReadStream(file).pipe(res)
    }
  } catch {
    // fall through to SPA shell
  }
  sendIndex(res)
}).listen(PORT, '0.0.0.0', () => console.log(`OpenPencil listening on ${PORT}`))
