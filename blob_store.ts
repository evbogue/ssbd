import { join } from "https://deno.land/std@0.207.0/path/mod.ts"
import { encode as encodeBase64 } from "https://deno.land/std@0.207.0/encoding/base64.ts"

const BLOB_DIR = 'blobs'
const HASH_SUFFIX = '.sha256'
const HASH_PREFIX = '%'
const HASH_REGEX = /^%[A-Za-z0-9+/=]{42,}\.sha256$/

export interface BlobMetadata {
  type?: string
  size: number
}

function hashToSlug(hash: string): string {
  const base = hash.slice(HASH_PREFIX.length, hash.length - HASH_SUFFIX.length)
  return base.replace(/\+/g, '-').replace(/\//g, '_')
}

async function computeBlobHash(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  const encoded = encodeBase64(digest)
  return `${HASH_PREFIX}${encoded}${HASH_SUFFIX}`
}

export function isValidBlobHash(hash: string): boolean {
  return HASH_REGEX.test(hash)
}

export class BlobStore {
  #baseDir: string
  #ready: Promise<void> | null = null

  constructor(private rootDir: string) {
    this.#baseDir = join(rootDir, BLOB_DIR)
  }

  async ensureReady(): Promise<void> {
    if (!this.#ready) {
      this.#ready = (async () => {
        try {
          await Deno.mkdir(this.#baseDir, { recursive: true })
        } catch (err) {
          if (!(err instanceof Deno.errors.AlreadyExists)) throw err
        }
      })()
    }
    return this.#ready
  }

  private resolvePath(hash: string): string {
    if (!isValidBlobHash(hash)) throw new Error('invalid blob hash')
    return join(this.#baseDir, hashToSlug(hash))
  }

  private resolveMetaPath(hash: string): string {
    return this.resolvePath(hash) + '.json'
  }

  async save(data: Uint8Array, options: { type?: string } = {}): Promise<{ hash: string; size: number; existed: boolean }> {
    await this.ensureReady()
    const hash = await computeBlobHash(data)
    const filePath = this.resolvePath(hash)
    let existed = false
    try {
      await Deno.stat(filePath)
      existed = true
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        await Deno.writeFile(filePath, data)
      } else {
        throw err
      }
    }
    if (options.type || !existed) {
      const meta: BlobMetadata = {
        type: options.type,
        size: data.length
      }
      try {
        await Deno.writeTextFile(this.resolveMetaPath(hash), JSON.stringify(meta))
      } catch (err) {
        console.warn('failed to persist blob metadata', err)
      }
    }
    return { hash, size: data.length, existed }
  }

  async get(hash: string): Promise<Uint8Array | null> {
    await this.ensureReady()
    try {
      return await Deno.readFile(this.resolvePath(hash))
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null
      throw err
    }
  }

  async getMetadata(hash: string): Promise<BlobMetadata | null> {
    await this.ensureReady()
    try {
      const raw = await Deno.readTextFile(this.resolveMetaPath(hash))
      const meta = JSON.parse(raw)
      if (!meta || typeof meta !== 'object') return null
      return {
        type: typeof meta.type === 'string' ? meta.type : undefined,
        size: typeof meta.size === 'number' ? meta.size : 0
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null
      console.warn('failed to read blob metadata', err)
      return null
    }
  }
}
