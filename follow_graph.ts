import { FeedEntry } from './feed.ts'

export class FollowGraph {
  #follows = new Map<string, Map<string, boolean>>()
  #root: string | null = null
  #maxHops: number

  constructor(maxHops = 3) {
    this.#maxHops = maxHops
  }

  setRoot(id: string | null | undefined): void {
    if (id && typeof id === 'string' && id.trim()) this.#root = id.trim()
    else this.#root = null
  }

  getRoot(): string | null {
    return this.#root
  }

  load(entries: FeedEntry[]): void {
    for (const entry of entries) {
      this.processEntry(entry)
    }
  }

  processEntry(entry: FeedEntry | null | undefined): boolean {
    if (!entry || !entry.value) return false
    const content = entry.value.content
    if (!content || typeof content !== 'object') return false
    if ((content as { type?: string }).type !== 'contact') return false
    const contact = (content as { contact?: string }).contact
    if (!contact || typeof contact !== 'string' || !contact.startsWith('@')) return false
    const following = Boolean((content as { following?: boolean }).following)
    let relations = this.#follows.get(entry.value.author)
    if (!relations) {
      relations = new Map<string, boolean>()
      this.#follows.set(entry.value.author, relations)
    }
    if (relations.get(contact) === following) return false
    relations.set(contact, following)
    return true
  }

  computeReachable(): Set<string> {
    if (!this.#root) return new Set()
    const visited = new Set<string>([this.#root])
    const reachable = new Set<string>()
    let frontier: string[] = [this.#root]
    for (let depth = 0; depth < this.#maxHops && frontier.length; depth++) {
      const next: string[] = []
      for (const node of frontier) {
        const neighbors = this.#follows.get(node)
        if (!neighbors) continue
        for (const [contact, isFollowing] of neighbors.entries()) {
          if (!isFollowing || !contact) continue
          if (visited.has(contact)) continue
          visited.add(contact)
          reachable.add(contact)
          next.push(contact)
        }
      }
      frontier = next
    }
    if (this.#root) reachable.delete(this.#root)
    return reachable
  }
}
