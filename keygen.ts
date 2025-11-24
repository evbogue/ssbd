import { decode as base64Decode, encode as base64Encode } from "https://deno.land/std@0.207.0/encoding/base64.ts";
import { parseArgs } from "https://deno.land/std@0.207.0/cli/parse_args.ts";
import tweetNacl from './deps/tweetnacl.js'
// Import shared WebCrypto helpers (JS module) for generating seed values
import { generateEd25519Keypair } from './public/lib/webcrypto-keys.js'

interface TweetNaCl {
  sign: {
    keyPair: {
      fromSeed(seed: Uint8Array): {
        publicKey: Uint8Array
        secretKey: Uint8Array
      }
    }
  }
}

const nacl = tweetNacl as TweetNaCl

type CurveTag = 'ed25519'

const DEFAULT_CURVE: CurveTag = 'ed25519'
const SEED_LENGTH = 32

export interface RawKeyPair {
  curve: CurveTag
  public: Uint8Array
  private?: Uint8Array
}

export interface KeyJSON {
  curve: CurveTag
  public: string
  private?: string
  id: string
}

function tagKey(key: Uint8Array, curve: CurveTag): string {
  return `${base64Encode(key)}.${curve}`
}

export function hasSigil(value: string): boolean {
  return /^(@|%|&)/.test(value)
}

export function getTag(value: string): string {
  const index = value.indexOf('.')
  if (index === -1) return ''
  return value.slice(index + 1)
}

export function toBuffer(value?: string | Uint8Array | null): Uint8Array | undefined {
  if (value == null) return undefined
  if (value instanceof Uint8Array) return value
  const startIndex = hasSigil(value) ? 1 : 0
  const endIndex = value.indexOf('.')
  const base = endIndex === -1 ? value.slice(startIndex) : value.slice(startIndex, endIndex)
  return base64Decode(base)
}

export function keysToJSON(keys: RawKeyPair, curve?: CurveTag): KeyJSON {
  const resolvedCurve = (keys.curve || curve || DEFAULT_CURVE) as CurveTag
  const pub = tagKey(keys.public, resolvedCurve)
  const priv = keys.private ? tagKey(keys.private, resolvedCurve) : undefined
  return {
    curve: resolvedCurve,
    public: pub,
    private: priv,
    id: `@${pub}`
  }
}

async function resolveSeed(seed?: Uint8Array): Promise<Uint8Array> {
  if (!seed) {
    const pair = await generateEd25519Keypair()
    return pair.privateSeed
  }
  if (seed.length !== SEED_LENGTH) {
    throw new Error(`seed must be ${SEED_LENGTH} bytes`)
  }
  return new Uint8Array(seed)
}

export async function generate(curve?: CurveTag, seed?: Uint8Array): Promise<KeyJSON> {
  const resolvedCurve = (curve || DEFAULT_CURVE) as CurveTag
  if (resolvedCurve !== DEFAULT_CURVE) {
    throw new Error(`unknown curve:${resolvedCurve}`)
  }
  const seedBytes = await resolveSeed(seed)
  const pair = nacl.sign.keyPair.fromSeed(seedBytes)
  return keysToJSON({
    curve: resolvedCurve,
    public: pair.publicKey,
    private: pair.secretKey
  })
}

if (import.meta.main) {
  const { _: [command], seed } = parseArgs(Deno.args)
  if (command !== 'generate') {
    console.error('usage: deno run keygen.ts generate [--seed base64]')
    Deno.exit(1)
  }
  const seedBytes = seed ? base64Decode(seed) : undefined
  const keys = await generate(DEFAULT_CURVE, seedBytes)
  console.log(JSON.stringify(keys))
}
