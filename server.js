// One Render Web Service: serves the built editor AND proxies Kilo on the same origin.
// Same origin => the browser never makes a CORS request.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
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

// In-memory request log (no keys or prompt text). GET /api/logs reads it.
const logs = []
function log(event) {
  const entry = { at: new Date().toISOString(), ...event }
  logs.push(entry)
  if (logs.length > 50) logs.shift()
  console.log(JSON.stringify(entry))
}

// Neon-backed state store for chat history + editor/model settings.
// API keys and credentials are NEVER sent here — they stay in browser storage.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2
    })
  : null
if (pool) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'
  )
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

  if (url.pathname === '/api/logs') {
    const expectedOrigin = `https://${req.headers.host || ''}`
    if (req.headers.origin && req.headers.origin !== expectedOrigin) {
      res.writeHead(403)
      return res.end('forbidden')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(logs))
  }

  // Same-origin state sync: chat history + settings (no credentials).
  if (url.pathname === '/api/state') {
    const expectedOrigin = `https://${req.headers.host || ''}`
    if (req.headers.origin && req.headers.origin !== expectedOrigin) {
      res.writeHead(403)
      return res.end('forbidden')
    }
    if (!pool) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'DATABASE_URL not configured' }))
    }
    if (req.method === 'GET') {
      try {
        const { rows } = await pool.query('SELECT data FROM app_state WHERE id = $1', ['default'])
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(rows[0]?.data ?? null))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: String(error) }))
      }
    }
    if (req.method === 'POST') {
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid state')
        await pool.query(
          `INSERT INTO app_state (id, data, updated_at) VALUES ('default', $1::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [JSON.stringify(data)]
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"ok":true}')
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: String(error) }))
      }
    }
    res.writeHead(405)
    return res.end()
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
      // Buffer the incoming body: Node's IncomingMessage is not reliably sent as a
      // fetch() body by undici, which made upstream see an empty JSON body (HTTP 400).
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      let meta = { bytes: body.length }
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        meta = {
          ...meta,
          model: parsed.model,
          stream: parsed.stream,
          messages: Array.isArray(parsed.messages) ? parsed.messages.length : null,
          tools: Array.isArray(parsed.tools) ? parsed.tools.length : null
        }
      } catch {
        meta = { ...meta, parseError: true }
      }
      const target = UPSTREAM + url.pathname.slice('/kilo'.length) + url.search
      const started = Date.now()
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
      })
      const contentType = upstream.headers.get('content-type') || 'application/json'
      log({
        kind: 'kilo',
        path: url.pathname,
        ...meta,
        status: upstream.status,
        contentType,
        ms: Date.now() - started
      })
      if (!upstream.ok) {
        try {
          const text = await upstream.clone().text()
          log({ kind: 'kilo-error', status: upstream.status, detail: text.slice(0, 500) })
        } catch {
          // response body may already be consumed
        }
      }
      res.writeHead(upstream.status, { ...CORS, 'content-type': contentType })
      if (upstream.body) {
        let responseBytes = 0
        const counter = new TransformStream({
          transform(chunk, controller) {
            responseBytes += chunk.byteLength
            controller.enqueue(chunk)
          },
          flush() {
            log({
              kind: 'kilo-stream',
              status: upstream.status,
              bytes: responseBytes,
              ms: Date.now() - started
            })
          }
        })
        Readable.fromWeb(upstream.body.pipeThrough(counter)).pipe(res)
      } else res.end()
    } catch (error) {
      log({ kind: 'proxy-error', path: url.pathname, detail: String(error) })
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
