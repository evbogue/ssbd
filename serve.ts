import { parseArgs as parseCliArgs } from "https://deno.land/std@0.207.0/cli/parse_args.ts"
import { fromFileUrl, join } from "https://deno.land/std@0.207.0/path/mod.ts"
import { appendContent, appendSignedMessage, appendSignedMessageLoose, readFeed, MessageValue, FeedEntry } from './feed.ts'
import { DEFAULT_KEY_DIR, loadOrCreateKeys } from './keys.ts'
import { FeedTracker } from './feed_tracker.ts'
import { FollowGraph } from './follow_graph.ts'
import { filterFeedEntries, jsonResponse, parseIntParam } from './http_utils.ts'
import { createRestBridgeManager, normalizeBridgeUrl, RestBridgeManager } from './rest_bridge.ts'
import { BlobStore, isValidBlobHash } from './blob_store.ts'

interface CliOptions {
  dir?: string
  host?: string
  port?: number
  bridgeUrl?: string
  bridgeAuthor?: string
  bridgeInterval?: number
}

interface ServerState {
  host: string
  port: number
}

const PUBLIC_DIR = fromFileUrl(new URL('./public', import.meta.url))
const ssbdSockets = new Set<WebSocket>()
const MAX_BLOB_BYTES = 5 * 1024 * 1024 // 5MB per upload

function resolvePublicPath(pathname: string): string | null {
  const rel = pathname.replace(/^\/+/, '')
  if (!rel || rel.includes('..')) return null
  const full = join(PUBLIC_DIR, rel)
  if (!full.startsWith(PUBLIC_DIR)) return null
  return full
}

async function serveStaticFile(filePath: string): Promise<Response> {
  try {
    const data = await Deno.readFile(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    let type = 'application/octet-stream'
    if (ext === 'html') type = 'text/html; charset=utf-8'
    else if (ext === 'js') type = 'application/javascript; charset=utf-8'
    else if (ext === 'css') type = 'text/css; charset=utf-8'
    else if (ext === 'json') type = 'application/json; charset=utf-8'
    return new Response(data, {
      status: 200,
      headers: { 'content-type': type }
    })
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return jsonResponse({ error: 'not found' }, 404)
    throw err
  }
}

function parseOptions(args: string[]): CliOptions {
  const parsed = parseCliArgs(args, {
    string: ['dir', 'host', 'bridge-url', 'bridge-author'],
    alias: { dir: ['d'], host: ['H'], port: ['p'] }
  })
  const opts: CliOptions = {}
  if (typeof parsed.dir === 'string' && parsed.dir.length) opts.dir = parsed.dir
  if (typeof parsed.host === 'string' && parsed.host.length) opts.host = parsed.host
  if (parsed.port != null) {
    const value = typeof parsed.port === 'number' ? parsed.port : parseInt(String(parsed.port), 10)
    if (!Number.isNaN(value)) opts.port = value
  }
  if (typeof parsed['bridge-url'] === 'string') {
    opts.bridgeUrl = parsed['bridge-url']
  }
  if (typeof parsed['bridge-author'] === 'string') {
    opts.bridgeAuthor = parsed['bridge-author']
  }
  if (parsed['bridge-interval'] != null) {
    const value =
      typeof parsed['bridge-interval'] === 'number'
        ? parsed['bridge-interval']
        : parseInt(String(parsed['bridge-interval']), 10)
    if (!Number.isNaN(value)) opts.bridgeInterval = value
  }
  return opts
}

function notFound(): Response {
  return new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}

function handleWebSocket(request: Request, keys: Awaited<ReturnType<typeof loadOrCreateKeys>>): Response {
  const { socket, response } = Deno.upgradeWebSocket(request)
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', id: keys.id, curve: keys.curve, public: keys.public }))
  })
  socket.addEventListener('message', event => {
    socket.send(JSON.stringify({ type: 'echo', received: event.data }))
  })
  socket.addEventListener('error', err => {
    console.error('websocket error', err)
  })
  return response
}

;(async () => {
  try {
    const cli = parseOptions(Deno.args)
    const dir = cli.dir || DEFAULT_KEY_DIR
    const hostname = cli.host || '127.0.0.1'
    const requestedPort = cli.port == null ? 8790 : cli.port
    const blobStore = new BlobStore(dir)
    await blobStore.ensureReady()
    const bridgeBaseUrl = normalizeBridgeUrl(cli.bridgeUrl ?? 'http://127.0.0.1:8927')
    const bridgeAuthor = cli.bridgeAuthor
    const bridgeInterval = cli.bridgeInterval && cli.bridgeInterval > 0 ? cli.bridgeInterval : 5000
    let cachedKeys: Awaited<ReturnType<typeof loadOrCreateKeys>> | null = null
    const keysPromise = loadOrCreateKeys(dir).then(keys => {
      cachedKeys = keys
      return keys
    })
    const baseKeys = cachedKeys ?? (await keysPromise)
    const initialEntries = await readFeed(dir, { reverse: false })
    const tracker = new FeedTracker(dir)
    await tracker.initialize()
    const followGraph = new FollowGraph(3)
    followGraph.load(initialEntries)

    let resolvedHost = hostname
    let resolvedPort = requestedPort

    const state: ServerState = { host: hostname, port: requestedPort }
    let restManager: RestBridgeManager | null = null

    async function appendAndNotify(fn: () => Promise<FeedEntry>): Promise<FeedEntry> {
      const entry = await fn()
      tracker.rememberKey(entry.key)
      const changed = followGraph.processEntry(entry)
      if (changed && restManager) {
        restManager.syncAuto(followGraph.computeReachable())
      }
      const payload = JSON.stringify({ type: 'entry', entry })
      for (const socket of ssbdSockets) {
        try {
          socket.send(payload)
        } catch (_) {
          try {
            socket.close()
          } catch (_) {}
          ssbdSockets.delete(socket)
        }
      }
      return entry
    }

    if (bridgeBaseUrl) {
      restManager = createRestBridgeManager({
        dir,
        baseUrl: bridgeBaseUrl,
        intervalMs: bridgeInterval,
        append: (value: MessageValue) => appendAndNotify(() => appendSignedMessageLoose(dir, value)),
        tracker,
        selfId: baseKeys.id
      })
    }

    if (restManager) {
      restManager
        .follow(null)
        .then(remoteId => {
          console.log('[rest-bridge] following upstream', remoteId)
          followGraph.setRoot(remoteId)
          restManager?.syncAuto(followGraph.computeReachable())
        })
        .catch(err => {
          console.warn('failed to start bridge follower', err instanceof Error ? err.message : String(err))
        })

      if (bridgeAuthor) {
        restManager
          .follow(bridgeAuthor)
          .then(author => console.log('[rest-bridge] also following', author))
          .catch(err => console.warn('failed to follow requested feed', err instanceof Error ? err.message : String(err)))
      }
    }

    function handleSyncSocket(request: Request): Response {
      const { socket, response } = Deno.upgradeWebSocket(request)
      ssbdSockets.add(socket)
      socket.addEventListener('close', () => ssbdSockets.delete(socket))
      socket.addEventListener('error', () => ssbdSockets.delete(socket))
      socket.addEventListener('message', event => {
        try {
          const data = JSON.parse(event.data)
          if (data && data.type === 'appendSigned' && data.msg) {
            appendAndNotify(() => appendSignedMessage(dir, data.msg)).catch(err => {
              socket.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
            })
          }
        } catch (err) {
          socket.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
        }
      })
      return response
    }

    const server = Deno.serve(
      {
        hostname,
        port: requestedPort,
        onListen(info) {
          resolvedHost = info.hostname
          resolvedPort = info.port
          state.host = resolvedHost
          state.port = resolvedPort
          keysPromise.then(keys => {
            const base = `http://${info.hostname}:${info.port}`
            console.log(
              JSON.stringify({
                event: 'listening',
                host: resolvedHost,
                port: resolvedPort,
                id: keys.id,
                public: keys.public,
                curve: keys.curve,
                ssbd: `${base}/`
              })
            )
          })
        }
      },
      async request => {
        const keys = cachedKeys ?? (await keysPromise)
        const url = new URL(request.url)
        const upgrade = (request.headers.get('upgrade') || '').toLowerCase()

        if (upgrade === 'websocket') {
          if (url.pathname === '/sync') return handleSyncSocket(request)
          if (url.pathname === '/stream') return handleWebSocket(request, keys)
          return notFound()
        }

        if (request.method === 'GET' && url.pathname === '/bridge/follows') {
          if (!restManager) return jsonResponse({ error: 'bridge disabled' }, 503)
          return jsonResponse({ follows: restManager.list() })
        }

        if (request.method === 'POST' && url.pathname === '/bridge/follow') {
          if (!restManager) return jsonResponse({ error: 'bridge disabled' }, 503)
          let payload: unknown
          try {
            payload = await request.json()
          } catch (err) {
            return jsonResponse({ error: 'invalid json', details: err instanceof Error ? err.message : String(err) }, 400)
          }
          const author =
            payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).author === 'string'
              ? ((payload as Record<string, string>).author || '').trim()
              : ''
          try {
            const followed = await restManager.follow(author || null)
            return jsonResponse({ followed, follows: restManager.list() })
          } catch (err) {
            return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }

        if (request.method === 'POST' && url.pathname === '/blobs/add') {
          try {
            const buffer = new Uint8Array(await request.arrayBuffer())
            if (!buffer.length) return jsonResponse({ error: 'empty blob' }, 400)
            if (buffer.length > MAX_BLOB_BYTES) {
              return jsonResponse({ error: 'blob too large', limit: MAX_BLOB_BYTES }, 413)
            }
            const type = request.headers.get('content-type') || 'application/octet-stream'
            const result = await blobStore.save(buffer, { type })
            return new Response(result.hash + '\n', {
              status: 200,
              headers: { 'content-type': 'text/plain; charset=utf-8' }
            })
          } catch (err) {
            console.error('blob upload failed', err)
            return jsonResponse({ error: 'blob upload failed', details: err instanceof Error ? err.message : String(err) }, 500)
          }
        }

        if (request.method === 'POST' && url.pathname === '/publish') {
          let payload: unknown
          try {
            payload = await request.json()
          } catch (err) {
            return jsonResponse({ error: 'invalid json', details: err instanceof Error ? err.message : String(err) }, 400)
          }
          if (payload && typeof payload === 'object') {
            const obj = payload as Record<string, unknown>
            if (obj.content && typeof obj.content === 'object') {
              try {
                const entry = await appendAndNotify(() => appendContent(dir, keys, obj.content as Record<string, unknown>))
                return jsonResponse(entry)
              } catch (err) {
                return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400)
              }
            }
            if (obj.msg && typeof obj.msg === 'object') {
              try {
                const entry = await appendAndNotify(() => appendSignedMessage(dir, obj.msg as MessageValue))
                return jsonResponse(entry)
              } catch (err) {
                return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400)
              }
            }
          }
          return jsonResponse({ error: 'payload must include content or msg' }, 400)
        }

        if (request.method === 'GET' && url.pathname === '/log.json') {
          const entries = await readFeed(dir, { limit: 100, reverse: true })
          return jsonResponse(entries)
        }

        if (request.method === 'GET' && url.pathname === '/feed') {
          const limit = parseIntParam(url.searchParams.get('limit'), 100)
          const reverse = url.searchParams.get('reverse') !== 'false'
          const entries = await readFeed(dir, { limit, reverse })
          return jsonResponse(entries)
        }

        if (request.method === 'GET' && url.pathname.startsWith('/feeds/')) {
          const author = decodeURIComponent(url.pathname.replace('/feeds/', ''))
          const since = parseIntParam(url.searchParams.get('since'), 0)
          const entries = await readFeed(dir, { reverse: false })
          return jsonResponse(filterFeedEntries(entries, author, since))
        }

        if (request.method === 'POST' && url.pathname.startsWith('/feeds/')) {
          let payload: unknown
          try {
            payload = await request.json()
          } catch (err) {
            return jsonResponse({ error: 'invalid json', details: err instanceof Error ? err.message : String(err) }, 400)
          }
          if (!payload || typeof payload !== 'object' || !(payload as Record<string, unknown>).msg) {
            return jsonResponse({ error: 'missing msg' }, 400)
          }
          try {
            const entry = await appendAndNotify(() => appendSignedMessage(dir, (payload as Record<string, MessageValue>).msg))
            return jsonResponse(entry)
          } catch (err) {
            return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }

        if (request.method === 'GET' && url.pathname === '/status') {
          return jsonResponse({
            id: keys.id,
            public: keys.public,
            curve: keys.curve,
            host: state.host,
            port: state.port
          })
        }

        if (request.method === 'GET' && url.pathname.startsWith('/blobs/')) {
          const hashRaw = url.pathname.slice('/blobs/'.length)
          const hash = decodeURIComponent(hashRaw)
          if (!isValidBlobHash(hash)) {
            return jsonResponse({ error: 'invalid blob id' }, 400)
          }
          try {
            const data = await blobStore.get(hash)
            if (!data) return jsonResponse({ error: 'blob not found' }, 404)
            const meta = await blobStore.getMetadata(hash)
            const headers = new Headers()
            headers.set('content-length', String(data.length))
            headers.set('content-type', (meta && meta.type) || 'application/octet-stream')
            headers.set('cache-control', 'public, max-age=31536000, immutable')
            return new Response(data, { status: 200, headers })
          } catch (err) {
            console.error('blob fetch failed', err)
            return jsonResponse({ error: 'blob fetch failed', details: err instanceof Error ? err.message : String(err) }, 500)
          }
        }

        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
          return serveStaticFile(join(PUBLIC_DIR, 'ssbd.html'))
        }

        if (request.method === 'GET' && url.pathname === '/ssbd') {
          return serveStaticFile(join(PUBLIC_DIR, 'ssbd.html'))
        }

        if (request.method === 'GET') {
          const publicPath = resolvePublicPath(url.pathname)
          if (publicPath) return serveStaticFile(publicPath)
        }

        return notFound()
      }
    )

    await server.finished
  } catch (err) {
    console.error('failed to start server', err)
    Deno.exit(1)
  }
})()
