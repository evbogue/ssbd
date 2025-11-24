import { FeedTracker } from './feed_tracker.ts'
import { FeedEntry, MessageValue } from './feed.ts'

export interface RestBridgeOptions {
  dir: string
  baseUrl: string
  intervalMs: number
  tracker: FeedTracker
  selfId: string
  append: (value: MessageValue) => Promise<FeedEntry>
}

export interface RestBridgeManager {
  follow(author?: string | null): Promise<string>
  list(): string[]
  syncAuto(authors: Iterable<string>): void
}

export function normalizeBridgeUrl(value?: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (!/^https?:$/.test(parsed.protocol)) return null
    let normalized = parsed.toString()
    if (normalized.endsWith('/')) normalized = normalized.replace(/\/+$/, '')
    return normalized
  } catch (_) {
    console.warn('rest bridge: invalid base url', value)
    return null
  }
}

async function fetchBridgeJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`bridge request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export function createRestBridgeManager(options: RestBridgeOptions): RestBridgeManager | null {
  if (!options.baseUrl) return null
  const intervalMs = Math.max(1000, options.intervalMs || 5000)
  const followers = new Map<string, { stop(): void }>()
  const manualTargets = new Set<string>()
  let autoTargets = new Set<string>()
  let defaultAuthor: string | null = null

  async function resolveAuthor(target?: string | null): Promise<string | null> {
    if (target && target.trim()) return target.trim()
    if (defaultAuthor) return defaultAuthor
    try {
      const status = await fetchBridgeJson<{ id?: string }>(new URL('/status', options.baseUrl).toString())
      if (status && typeof status.id === 'string') {
        defaultAuthor = status.id
        console.log(`[rest-bridge] default remote author ${defaultAuthor}`)
        return defaultAuthor
      }
    } catch (err) {
      console.warn('rest bridge status error', err instanceof Error ? err.message : String(err))
    }
    return null
  }

  function startFollower(author: string) {
    let syncing = false

    async function syncOnce(): Promise<void> {
      if (syncing) return
      syncing = true
      try {
        const since = options.tracker.getHighest(author)
        const feedUrl = new URL(`/feeds/${encodeURIComponent(author)}?since=${since}`, options.baseUrl).toString()
        const entries = await fetchBridgeJson<Array<{ key?: string; value?: MessageValue }>>(feedUrl)
        if (!Array.isArray(entries) || entries.length === 0) return
        let applied = 0
        let expectedSeq = since
        for (const entry of entries) {
          const value = entry?.value
          if (!value || typeof value.sequence !== 'number') continue
          if (entry?.key && options.tracker.hasKey(entry.key)) {
            expectedSeq = Math.max(expectedSeq, value.sequence)
            continue
          }
          if (value.sequence <= expectedSeq) {
            expectedSeq = Math.max(expectedSeq, value.sequence)
            continue
          }
          try {
            const saved = await options.append(value)
            const rememberedKey = entry?.key || saved.key
            if (rememberedKey) options.tracker.rememberKey(rememberedKey)
            const type = value.content && typeof value.content === 'object' && (value.content as { type?: string }).type
            console.log(
              `[rest-bridge] syncing ${value.author} #${value.sequence}` + (type ? ` (${type})` : '') +
                (rememberedKey ? ` ${rememberedKey.slice(0, 12)}…` : '')
            )
            applied += 1
            expectedSeq = value.sequence
          } catch (err) {
            const details = {
              message: err instanceof Error ? err.message : String(err),
              author: value.author,
              sequence: value.sequence,
              previous: value.previous,
              expectedSequence: expectedSeq + 1,
              baseUrl: options.baseUrl
            }
            console.warn('rest bridge append failed', details)
          }
        }
        if (applied > 0) {
          try {
            await options.tracker.recomputeAuthor(author)
          } catch (err) {
            console.warn('rest bridge recompute failed', err instanceof Error ? err.message : String(err))
          }
          console.log(`[rest-bridge] synced ${applied} entr${applied === 1 ? 'y' : 'ies'} from ${author}`)
        }
      } catch (err) {
        console.warn('rest bridge sync error', err instanceof Error ? err.message : String(err))
      } finally {
        syncing = false
      }
    }

    syncOnce()
    const timer = setInterval(() => syncOnce(), intervalMs)
    return {
      stop() {
        clearInterval(timer)
      }
    }
  }

  function updateFollowers() {
    const desired = new Set<string>()
    for (const id of manualTargets) {
      if (id && id !== options.selfId) desired.add(id)
    }
    for (const id of autoTargets) {
      if (id && id !== options.selfId) desired.add(id)
    }
    for (const author of desired) {
      if (!followers.has(author)) {
        followers.set(author, startFollower(author))
      }
    }
    for (const [author, follower] of followers.entries()) {
      if (!desired.has(author)) {
        follower.stop()
        followers.delete(author)
      }
    }
  }

  async function follow(target?: string | null): Promise<string> {
    const author = await resolveAuthor(target)
    if (!author) throw new Error('unable to resolve bridge author')
    manualTargets.add(author)
    updateFollowers()
    return author
  }

  function list(): string[] {
    return Array.from(followers.keys())
  }

  function syncAuto(authors: Iterable<string>): void {
    autoTargets = new Set<string>()
    for (const id of authors) {
      if (id && typeof id === 'string') autoTargets.add(id)
    }
    updateFollowers()
  }

  return { follow, list, syncAuto }
}
