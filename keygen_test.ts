import { assert } from "jsr:@std/assert/assert";
import { assertEquals } from "jsr:@std/assert/equals";
import { generate, toBuffer } from './keygen.ts'

Deno.test('generate returns an ed25519 key pair with matching metadata', async () => {
  const keys = await generate()
  assertEquals(keys.curve, 'ed25519')
  assert(keys.id.startsWith('@'), 'id should include sigil')
  const pub = toBuffer(keys.public)
  const priv = toBuffer(keys.private)
  assert(pub instanceof Uint8Array && pub.length === 32, 'public key should be 32 bytes')
  assert(priv instanceof Uint8Array && priv.length === 64, 'private key should be 64 bytes')
  assert(keys.id.slice(1).startsWith(keys.public), 'id should mirror tagged public key')
})
