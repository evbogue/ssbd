import { readFeed, FeedEntry, FeedMeta, validateMessage } from './feed.ts'

export interface AuthorProgress {
  contiguous: number
  highest: number
}

export class FeedTracker {
  #knownKeys = new Set<string>()
  #progress = new Map<string, AuthorProgress>()
  #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  async initialize(): Promise<void> {
    this.#knownKeys.clear()
    this.#progress.clear()
    const entries = await readFeed(this.#dir, { reverse: false })
    for (const entry of entries) {
      if (entry && typeof entry.key === 'string') this.#knownKeys.add(entry.key)
    }
    const byAuthor = new Map<string, FeedEntry[]>()
    for (const entry of entries) {
      if (!entry || !entry.value || typeof entry.value.author !== 'string') continue
      const authorEntries = byAuthor.get(entry.value.author) ?? []
      authorEntries.push(entry)
      byAuthor.set(entry.value.author, authorEntries)
    }
    for (const [author, authorEntries] of byAuthor.entries()) {
      authorEntries.sort((a, b) => {
        const seqA = a.value?.sequence ?? 0
        const seqB = b.value?.sequence ?? 0
        return seqA - seqB
      })
      this.#progress.set(author, await this.#computeProgress(authorEntries))
    }
  }

  hasKey(key?: string | null): boolean {
    if (!key) return false
    return this.#knownKeys.has(key)
  }

  rememberKey(key?: string | null): void {
    if (!key) return
    this.#knownKeys.add(key)
  }

  getContiguous(author: string): number {
    const state = this.#progress.get(author)
    return state ? state.contiguous : 0
  }

  getHighest(author: string): number {
    const state = this.#progress.get(author)
    return state ? state.highest : 0
  }

  async recomputeAuthor(author: string): Promise<AuthorProgress> {
    const entries = await readFeed(this.#dir, { reverse: false })
    const filtered = entries
      .filter(entry => entry.value && entry.value.author === author)
      .sort((a, b) => (a.value?.sequence ?? 0) - (b.value?.sequence ?? 0))
    const progress = await this.#computeProgress(filtered)
    this.#progress.set(author, progress)
    return progress
  }

  async #computeProgress(entries: FeedEntry[]): Promise<AuthorProgress> {
    let contiguous = 0
    let prev: FeedMeta | null = null
    for (const entry of entries) {
      if (!entry.value) continue
      try {
        await validateMessage(entry.value, prev, { enforceSequence: true })
        contiguous = entry.value.sequence
        prev = {
          id: entry.key,
          sequence: entry.value.sequence,
          timestamp: entry.value.timestamp
        }
      } catch (_) {
        break
      }
    }
    const highest = entries.length ? entries[entries.length - 1].value.sequence : 0
    return { contiguous, highest }
  }
}
