const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function bufToBase64(bytes) {
  var binary = ''
  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function base64ToBuf(value) {
  var binary = atob(value)
  var bytes = new Uint8Array(binary.length)
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function readLength(bytes, offset) {
  var initial = bytes[offset]
  if (initial < 0x80) {
    return { length: initial, read: 1 }
  }
  var numBytes = initial & 0x7f
  var value = 0
  for (var i = 0; i < numBytes; i++) {
    value = (value << 8) | bytes[offset + 1 + i]
  }
  return { length: value, read: 1 + numBytes }
}

export function pkcs8ToSeed(pkcs8) {
  var bytes = pkcs8 instanceof Uint8Array ? pkcs8 : new Uint8Array(pkcs8)
  var offset = 0
  if (bytes[offset] !== 0x30) throw new Error('invalid pkcs8 structure')
  var topLen = readLength(bytes, offset + 1)
  offset += 1 + topLen.read
  if (bytes[offset] !== 0x02) throw new Error('invalid pkcs8 version')
  var versionLen = readLength(bytes, offset + 1)
  offset += 1 + versionLen.read + versionLen.length
  if (bytes[offset] !== 0x30) throw new Error('missing algorithm identifier')
  var algLen = readLength(bytes, offset + 1)
  offset += 1 + algLen.read + algLen.length
  if (bytes[offset] !== 0x04) throw new Error('missing private key octet string')
  var pkLen = readLength(bytes, offset + 1)
  offset += 1 + pkLen.read
  if (bytes[offset] !== 0x04) throw new Error('missing seed octet string')
  var seedLen = readLength(bytes, offset + 1)
  offset += 1 + seedLen.read
  return bytes.slice(offset, offset + seedLen.length)
}

export async function generateEd25519Keypair() {
  var keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  var publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  var privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
  var privateSeed = pkcs8ToSeed(privateKeyPkcs8)
  return {
    cryptoKeyPair: keyPair,
    publicKeyBytes: publicKeyBytes,
    privateKeyPkcs8: privateKeyPkcs8,
    privateSeed: privateSeed
  }
}

export function canonicalizeMessage(msg, dropSignature) {
  var ordered = {}
  Object.keys(msg || {}).forEach(function (key) {
    if (dropSignature && key === 'signature') return
    ordered[key] = msg[key]
  })
  return JSON.stringify(ordered, null, 2)
}

export function encodeUtf8(value) {
  return encoder.encode(value)
}

export function decodeUtf8(bytes) {
  return decoder.decode(bytes)
}

export function toTaggedId(bytes) {
  return '@' + bufToBase64(bytes) + '.ed25519'
}

export function toTaggedSig(bytes) {
  return bufToBase64(bytes) + '.sig.ed25519'
}

export function parseTagged(value) {
  var index = value.indexOf('.')
  if (index === -1) return { base: value.startsWith('@') ? value.slice(1) : value, suffix: '' }
  var base = value.slice(value.startsWith('@') ? 1 : 0, index)
  var suffix = value.slice(index)
  return { base: base, suffix: suffix }
}

export function baseToKeyBytes(tagged) {
  var parsed = parseTagged(tagged)
  return base64ToBuf(parsed.base)
}

export function toTaggedKey(bytes) {
  return bufToBase64(bytes) + '.ed25519'
}

export function toTaggedSeed(seed) {
  return bufToBase64(seed) + '.priv.ed25519'
}

export function ensureCrypto() {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('WebCrypto Ed25519 not available')
  }
}

export function importPrivateKey(pkcs8Bytes) {
  ensureCrypto()
  return crypto.subtle.importKey('pkcs8', pkcs8Bytes, { name: 'Ed25519' }, false, ['sign'])
}

export function importPublicKey(rawBytes) {
  ensureCrypto()
  return crypto.subtle.importKey('raw', rawBytes, { name: 'Ed25519' }, true, ['verify'])
}

export async function signBytes(privateKey, data) {
  ensureCrypto()
  var result = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data)
  return new Uint8Array(result)
}

export async function verifyBytes(publicKey, signature, data) {
  ensureCrypto()
  return crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, data)
}
