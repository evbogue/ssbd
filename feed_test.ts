import { assertEquals, assertRejects } from "https://deno.land/std@0.207.0/assert/mod.ts";
import {
  appendContent,
  appendSignedMessage,
  createMemoryStorageAdapter,
  readFeed,
  setFeedStorageAdapter,
  signValue,
  UnsignedValue
} from './feed.ts'
import { generate } from './keygen.ts'

Deno.test('appendContent writes sequential log entries for server keys', async () => {
  const dir = await Deno.makeTempDir()
  const keys = await generate()
  const first = await appendContent(dir, keys, { type: 'post', text: 'hello' })
  const second = await appendContent(dir, keys, { type: 'post', text: 'world' })
  assertEquals(first.value.sequence, 1)
  assertEquals(second.value.sequence, 2)
  assertEquals(second.value.previous, first.key)
  const log = await readFeed(dir, { reverse: false })
  assertEquals(log.length, 2)
  assertEquals(log[0].key, first.key)
  assertEquals(log[1].key, second.key)
})

Deno.test('appendSignedMessage validates signature and sequence per feed', async () => {
  const dir = await Deno.makeTempDir()
  const keys = await generate()
  const unsigned: UnsignedValue = {
    previous: null,
    author: keys.id,
    sequence: 1,
    timestamp: Date.now(),
    hash: 'sha256',
    content: { type: 'post', text: 'from client' }
  }
  const signed = await signValue(keys, unsigned)
  const stored = await appendSignedMessage(dir, signed)
  assertEquals(stored.key, stored.value.previous === null ? stored.key : stored.key)

  const tampered = { ...signed, signature: signed.signature.replace(/A/, 'B') }
  await assertRejects(() => appendSignedMessage(dir, tampered))
})

Deno.test('memory storage adapter stores feed data for browser environments', async () => {
  const adapter = createMemoryStorageAdapter()
  setFeedStorageAdapter(adapter)
  try {
    const dir = `browser-${crypto.randomUUID()}`
    const keys = await generate()
    const first = await appendContent(dir, keys, { type: 'post', text: 'hello from browser' })
    const unsigned: UnsignedValue = {
      previous: first.key,
      author: keys.id,
      sequence: 2,
      timestamp: first.value.timestamp + 1,
      hash: 'sha256',
      content: { type: 'post', text: 'follow up' }
    }
    const signed = await signValue(keys, unsigned)
    await appendSignedMessage(dir, signed)
    const entries = await readFeed(dir, { reverse: false })
    assertEquals(entries.length, 2)
    assertEquals(entries[0].key, first.key)
    assertEquals(entries[1].value.sequence, 2)
    assertEquals(entries[1].value.previous, first.key)
  } finally {
    setFeedStorageAdapter(null)
  }
})
