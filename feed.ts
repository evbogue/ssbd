import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64"
import tweetNacl from './deps/tweetnacl.js'
import { KeyJSON, toBuffer } from './keygen.ts'
import { getFeedStorageAdapter } from './storage.ts'
import { canonicalBytes } from './canonical.mjs'

export { createMemoryStorageAdapter, setFeedStorageAdapter, type FeedStorageAdapter } from './storage.ts'

const LOG_FILENAME = 'log.jsonl'
const META_FILENAME = 'log.meta.json'
const nacl = tweetNacl as any

export interface FeedMeta {
  id: string | null
  sequence: number
  timestamp: number
}

export interface UnsignedValue {
  previous: string | null
  author: string
  sequence: number
  timestamp: number
  hash: 'sha256'
  content: Record<string, unknown> | string
}

export interface MessageValue extends UnsignedValue {
  signature: string
}

export interface FeedEntry {
  key: string
  value: MessageValue
  timestamp: number
}

export interface FeedReadOptions {
  limit?: number
  reverse?: boolean
}

interface FeedStateFile {
  feeds: Record<string, FeedMeta>
}

interface ValidationOptions {
  enforceSequence?: boolean
}

function emptyState(): FeedMeta {
  return { id: null, sequence: 0, timestamp: 0 }
}

function defaultStateFile(): FeedStateFile {
  return { feeds: {} }
}

const feedLocks = new Map<string, Promise<unknown>>()

async function readMeta(dir: string): Promise<FeedStateFile> {
  const storage = await getFeedStorageAdapter()
  const text = await storage.readFile(dir, META_FILENAME)
  if (!text || !text.trim()) return defaultStateFile()
  const parsed = JSON.parse(text) as FeedStateFile
  if (!parsed || typeof parsed !== 'object' || typeof parsed.feeds !== 'object') {
    return defaultStateFile()
  }
  const feeds: Record<string, FeedMeta> = {}
  for (const [author, state] of Object.entries(parsed.feeds)) {
    feeds[author] = {
      id: state?.id ?? null,
      sequence: typeof state?.sequence === 'number' ? state.sequence : 0,
      timestamp: typeof state?.timestamp === 'number' ? state.timestamp : 0
    }
  }
  return { feeds }
}

async function writeMeta(dir: string, meta: FeedStateFile): Promise<void> {
  const storage = await getFeedStorageAdapter()
  await storage.writeFile(dir, META_FILENAME, JSON.stringify(meta, null, 2))
}

async function appendLog(dir: string, entry: FeedEntry): Promise<void> {
  const storage = await getFeedStorageAdapter()
  await storage.appendFile(dir, LOG_FILENAME, JSON.stringify(entry) + '\n')
}

function parseSignature(signature: string): Uint8Array {
  const suffix = '.sig.ed25519'
  if (!signature || typeof signature !== 'string' || !signature.endsWith(suffix)) {
    throw new Error('invalid signature format')
  }
  const base = signature.slice(0, -suffix.length)
  return decodeBase64(base)
}

async function computeHash(value: UnsignedValue | MessageValue): Promise<{ key: string; bytes: Uint8Array }> {
  if (value.hash !== 'sha256') {
    throw new Error('unsupported hash type')
  }
  const bytes = canonicalBytes(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hashBytes = new Uint8Array(digest)
  const key = `%${encodeBase64(hashBytes)}.sha256`
  return { key, bytes }
}

async function withFeedLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const current = feedLocks.get(dir) ?? Promise.resolve()
  const next = current.then(fn)
  feedLocks.set(dir, next.catch(() => {}))
  try {
    const result = await next
    if (feedLocks.get(dir) === next) feedLocks.delete(dir)
    return result
  } catch (err) {
    if (feedLocks.get(dir) === next) feedLocks.delete(dir)
    throw err
  }
}

export async function signValue(keys: KeyJSON, value: UnsignedValue): Promise<MessageValue> {
  if (value.author !== keys.id) {
    throw new Error('author must match signing keys')
  }
  const privateKey = toBuffer(keys.private)
  if (!privateKey) throw new Error('missing private key bytes')
  const signed = nacl.sign.detached(canonicalBytes(value), privateKey)
  const signature = `${encodeBase64(signed)}.sig.ed25519`
  return { ...value, signature }
}

export async function validateMessage(value: MessageValue, state?: FeedMeta | null, options: ValidationOptions = {}): Promise<{ key: string }> {
  const prev = state ?? null
  const enforceSequence = options.enforceSequence !== false
  if (typeof value.sequence !== 'number' || value.sequence < 1 || !Number.isInteger(value.sequence)) {
    throw new Error('invalid sequence')
  }
  if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) {
    throw new Error('invalid timestamp')
  }
  if (!value.author || typeof value.author !== 'string' || !value.author.startsWith('@')) {
    throw new Error('invalid author')
  }
  if (!value.content || (typeof value.content !== 'object' && typeof value.content !== 'string')) {
    throw new Error('invalid content')
  }

  if (enforceSequence) {
    if (prev && value.sequence !== prev.sequence + 1) {
      throw new Error('sequence does not follow previous state')
    }
    if (!prev && value.sequence !== 1) {
      throw new Error('first message must have sequence 1')
    }
    if (prev && value.previous !== prev.id) {
      throw new Error('previous pointer mismatch')
    }
    if (!prev && value.previous !== null) {
      throw new Error('first message must have null previous')
    }
    if (prev && value.timestamp <= prev.timestamp) {
      throw new Error('timestamp must increase')
    }
  }

  const { key, bytes } = await computeHash(value)
  const publicKey = toBuffer(value.author)
  if (!publicKey) throw new Error('invalid public key bytes')
  const sigBytes = parseSignature(value.signature)
  const verified = nacl.sign.detached.verify(bytes, sigBytes, publicKey)
  if (!verified) {
    throw new Error('invalid signature')
  }
  return { key }
}

function stateForAuthor(meta: FeedStateFile, author: string): FeedMeta {
  return meta.feeds[author] ? { ...meta.feeds[author] } : emptyState()
}

async function appendWithState(
  dir: string,
  value: MessageValue,
  metaFile: FeedStateFile,
  opts: ValidationOptions = {}
): Promise<FeedEntry> {
  const authorState = stateForAuthor(metaFile, value.author)
  const { key } = await validateMessage(value, authorState, opts)
  const entry: FeedEntry = {
    key,
    value,
    timestamp: Date.now()
  }
  await appendLog(dir, entry)
  metaFile.feeds[value.author] = {
    id: key,
    sequence: value.sequence,
    timestamp: value.timestamp
  }
  await writeMeta(dir, metaFile)
  return entry
}

export async function appendSignedMessage(dir: string, value: MessageValue): Promise<FeedEntry> {
  return withFeedLock(dir, async () => {
    const metaFile = await readMeta(dir)
    return appendWithState(dir, value, metaFile, { enforceSequence: true })
  })
}

export async function appendSignedMessageLoose(dir: string, value: MessageValue): Promise<FeedEntry> {
  return withFeedLock(dir, async () => {
    const metaFile = await readMeta(dir)
    return appendWithState(dir, value, metaFile, { enforceSequence: false })
  })
}

export async function appendContent(dir: string, keys: KeyJSON, content: Record<string, unknown>): Promise<FeedEntry> {
  return withFeedLock(dir, async () => {
    const metaFile = await readMeta(dir)
    const current = stateForAuthor(metaFile, keys.id)
    const timestamp = Math.max(Date.now(), current.timestamp + 1)
    const unsigned: UnsignedValue = {
      previous: current.id,
      author: keys.id,
      sequence: current.sequence + 1,
      timestamp,
      hash: 'sha256',
      content
    }
    const signed = await signValue(keys, unsigned)
    return appendWithState(dir, signed, metaFile)
  })
}

export async function getAuthorState(dir: string, author: string): Promise<FeedMeta> {
  const metaFile = await readMeta(dir)
  return stateForAuthor(metaFile, author)
}

export async function readFeed(dir: string, opts: FeedReadOptions = {}): Promise<FeedEntry[]> {
  const storage = await getFeedStorageAdapter()
  const text = await storage.readFile(dir, LOG_FILENAME)
  if (!text) return []
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const entries: FeedEntry[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as FeedEntry
      if (parsed && parsed.value && typeof parsed.key === 'string') {
        entries.push(parsed)
      }
    } catch (err) {
      console.error('failed to parse feed line', err)
    }
  }

  const reverse = opts.reverse !== undefined ? Boolean(opts.reverse) : true
  if (reverse) entries.reverse()
  const limit = opts.limit
  if (typeof limit === 'number' && limit >= 0) {
    return entries.slice(0, limit)
  }
  return entries
}
