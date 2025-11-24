import { appendContent, appendSignedMessage, readFeed } from './feed.ts'
import { DEFAULT_KEY_DIR, loadOrCreateKeys } from './keys.ts'
import { filterFeedEntries, jsonResponse, parseIntParam } from './http_utils.ts'

export async function createSsbdServer(options = {}) {
  const dir = options.dir || DEFAULT_KEY_DIR
  const host = options.host || '127.0.0.1'
  const port = options.port == null ? 8989 : options.port
  const keys = await loadOrCreateKeys(dir)
  const sockets = new Set()

  async function appendAndNotify(fn) {
    const entry = await fn()
    const payload = JSON.stringify({ type: 'entry', entry })
    sockets.forEach(socket => {
      try {
        socket.send(payload)
      } catch (_) {
        try { socket.close() } catch (_) {}
        sockets.delete(socket)
      }
    })
    return entry
  }

  function handleWebSocket(request) {
    const { socket, response } = Deno.upgradeWebSocket(request)
    sockets.add(socket)
    socket.addEventListener('close', () => sockets.delete(socket))
    socket.addEventListener('error', () => sockets.delete(socket))
    socket.addEventListener('message', event => {
      try {
        const data = JSON.parse(event.data)
        if (data && data.type === 'appendSigned' && data.msg) {
          appendAndNotify(() => appendSignedMessage(dir, data.msg))
            .then(entry => {
              socket.send(JSON.stringify({ type: 'ack', key: entry.key }))
            })
            .catch(err => {
              socket.send(JSON.stringify({ type: 'error', message: err.message || String(err) }))
            })
        }
      } catch (err) {
        socket.send(JSON.stringify({ type: 'error', message: err.message || String(err) }))
      }
    })
    return response
  }

  const server = Deno.serve(
    {
      hostname: host,
      port,
      onListen(info) {
        console.log(
          JSON.stringify({
            event: 'listening',
            host: info.hostname,
            port: info.port,
            id: keys.id
          })
        )
      }
    },
    async request => {
      const url = new URL(request.url)
      const pathname = url.pathname
      const upgrade = (request.headers.get('upgrade') || '').toLowerCase()
      if (upgrade === 'websocket' && pathname === '/sync') {
        return handleWebSocket(request)
      }

      if (request.method === 'GET' && pathname === '/status') {
        return jsonResponse({
          id: keys.id,
          public: keys.public,
          curve: keys.curve,
          host,
          port
        })
      }

      if (request.method === 'GET' && pathname === '/feed') {
        const entries = await readFeed(dir, {
          limit: parseIntParam(url.searchParams.get('limit') ?? '', 100),
          reverse: url.searchParams.get('reverse') !== 'false'
        })
        return jsonResponse(entries)
      }

      if (request.method === 'GET' && pathname.startsWith('/feeds/')) {
        const author = decodeURIComponent(pathname.replace('/feeds/', ''))
        const since = parseIntParam(url.searchParams.get('since') ?? '', 0)
        const entries = await readFeed(dir, { reverse: false })
        return jsonResponse(filterFeedEntries(entries, author, since))
      }

      if (request.method === 'POST' && pathname === '/publish') {
        let payload
        try {
          payload = await request.json()
        } catch (err) {
          return jsonResponse({ error: 'invalid json', details: err.message || String(err) }, 400)
        }
        if (payload && payload.content && typeof payload.content === 'object') {
          try {
            const entry = await appendAndNotify(() => appendContent(dir, keys, payload.content))
            return jsonResponse(entry)
          } catch (err) {
            return jsonResponse({ error: err.message || String(err) }, 400)
          }
        }
        if (payload && payload.msg) {
          try {
            const entry = await appendAndNotify(() => appendSignedMessage(dir, payload.msg))
            return jsonResponse(entry)
          } catch (err) {
            return jsonResponse({ error: err.message || String(err) }, 400)
          }
        }
        return jsonResponse({ error: 'payload must include content or msg' }, 400)
      }

      if (request.method === 'POST' && pathname.startsWith('/feeds/')) {
        let payload
        try {
          payload = await request.json()
        } catch (err) {
          return jsonResponse({ error: 'invalid json', details: err.message || String(err) }, 400)
        }
        if (!payload || !payload.msg) {
          return jsonResponse({ error: 'missing msg' }, 400)
        }
        try {
          const entry = await appendAndNotify(() => appendSignedMessage(dir, payload.msg))
          return jsonResponse(entry)
        } catch (err) {
          return jsonResponse({ error: err.message || String(err) }, 400)
        }
      }

      if (request.method === 'GET' && pathname === '/') {
        return jsonResponse({
          message: 'secure-scuttlebot-deno server',
          id: keys.id,
          endpoints: ['/status', '/feed', '/feeds/:id', '/publish', '/sync (ws)']
        })
      }

      return jsonResponse({ error: 'not found' }, 404)
    }
  )

  return {
    keys,
    close() {
      sockets.forEach(socket => {
        try { socket.close() } catch (_) {}
      })
      if (server.shutdown) return server.shutdown()
    },
    finished: server.finished
  }
}

export async function startSsbdServer(options = {}) {
  return createSsbdServer(options)
}
