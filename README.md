# OpenPencil + Kilo on Render free Web Service

Serves the static editor and proxies Kilo on the SAME origin, so the browser
makes no cross-origin request and CORS cannot block it.

## Why this works
Kilo's gateway sends no `Access-Control-Allow-Origin`, so direct browser calls
from GitHub Pages/Render Static Sites fail. Here the editor calls
`/kilo/chat/completions` on its own domain; the Node server forwards it to
Kilo server-side. Same origin = no CORS.

## Deploy on Render (free)
1. Create a new GitHub repo from this folder (`server.js`, `package.json`, `README.md`).
2. Render Dashboard -> New -> Web Service -> connect that repo.
3. Runtime: **Node** (Render reads `engines.node >= 22`).
4. **Build Command:**
   ```
   npm install
   git clone --depth 1 --branch site https://github.com/dune-ai-test/dune-ai-test.github.io.git dist
   ```
5. **Start Command:** `node server.js`
6. **Environment:** `DATABASE_URL` = your Neon **pooled** connection string.
7. Plan: **Free**. Health Check Path: `/ready`.
8. Create. You get `https://<name>.onrender.com`.

The server creates an `app_state` table in Neon on startup. `/api/state`
(GET/POST) stores chat history + editor/model settings as one JSON document.
No API keys or credentials are ever sent to it.

## Configure the editor
- Open the service URL, press Ctrl+J, Settings -> Models -> Add, choose OpenAI-compatible:
  - Base URL: `https://<name>.onrender.com/kilo`
  - API key: your Kilo gateway key
  - Model ID: e.g. `anthropic/claude-sonnet-4.5`
- Chat now works without CORS errors.

## Notes
- Free web services spin down after 15 min idle; first request after that takes ~1 min.
- Use the official Kilo base: `https://ai-gateway.kilo.ai/api/v1` (the server proxies there).
- The proxy streams responses, so SSE chat still works. Your key is only forwarded, never stored.
- To update the editor, rebuild the `site` branch (GitHub Action) then redeploy this
  service so it re-clones `dist`.
