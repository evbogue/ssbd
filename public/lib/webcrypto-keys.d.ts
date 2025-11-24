export function bufToBase64(bytes: Uint8Array): string
export function base64ToBuf(value: string): Uint8Array
export function pkcs8ToSeed(pkcs8: Uint8Array | ArrayBuffer): Uint8Array
export function canonicalizeMessage(msg: {
  previous: string | null
  author: string
  sequence: number
  timestamp: number
  hash: string
  content: unknown
}): string
export function encodeUtf8(value: string): Uint8Array
export function decodeUtf8(bytes: Uint8Array): string
export function toTaggedId(bytes: Uint8Array): string
export function toTaggedSig(bytes: Uint8Array): string
export function parseTagged(value: string): { base: string; suffix: string }
export function baseToKeyBytes(tagged: string): Uint8Array
export function toTaggedKey(bytes: Uint8Array): string
export function toTaggedSeed(seed: Uint8Array): string
export function ensureCrypto(): void
export function importPrivateKey(pkcs8Bytes: Uint8Array | ArrayBuffer): Promise<CryptoKey>
export function importPublicKey(rawBytes: Uint8Array | ArrayBuffer): Promise<CryptoKey>
export function signBytes(privateKey: CryptoKey, data: Uint8Array | ArrayBuffer): Promise<Uint8Array>
export function verifyBytes(publicKey: CryptoKey, signature: Uint8Array | ArrayBuffer, data: Uint8Array | ArrayBuffer): Promise<boolean>
export interface GeneratedKeypair {
  cryptoKeyPair: CryptoKeyPair
  publicKeyBytes: Uint8Array
  privateKeyPkcs8: Uint8Array
  privateSeed: Uint8Array
}
export function generateEd25519Keypair(): Promise<GeneratedKeypair>
