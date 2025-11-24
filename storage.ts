type IDBFactoryType = {
  open(name: string, version?: number): any
} | null | undefined
type IDBDatabaseType = any
type IDBRequestType<T = unknown> = {
  onsuccess: ((this: IDBRequestType<T>, ev: unknown) => unknown) | null
  onerror: ((this: IDBRequestType<T>, ev: unknown) => unknown) | null
  result: T
  error: unknown
}

const denoNs = (globalThis as typeof globalThis & { Deno?: typeof Deno }).Deno
const hasFileSystemAccess = Boolean(denoNs && typeof denoNs.readTextFile === 'function')
const indexedDbFactory = (globalThis as typeof globalThis & { indexedDB?: IDBFactoryType }).indexedDB as IDBFactoryType

const LOG_STORE = 'files'
const DB_NAME = 'ssb-apds'

export interface FeedStorageAdapter {
  readFile(dir: string, filename: string): Promise<string | null>
  writeFile(dir: string, filename: string, data: string): Promise<void>
  appendFile(dir: string, filename: string, data: string): Promise<void>
}

let storageOverride: FeedStorageAdapter | null = null
let defaultAdapterPromise: Promise<FeedStorageAdapter> | null = null
let fileAdapter: FeedStorageAdapter | null = null
let indexedDbAdapterPromise: Promise<FeedStorageAdapter> | null = null

function storageKey(dir: string, filename: string): string {
  return `${dir || 'default'}/${filename}`
}

function pathJoin(dir: string, filename: string): string {
  if (!dir) return filename
  if (dir.endsWith('/') || dir.endsWith('\\')) {
    return dir + filename
  }
  const usesBackslash = dir.includes('\\') && !dir.includes('/')
  const sep = usesBackslash ? '\\' : '/'
  return dir + sep + filename
}

async function ensureDir(dir: string): Promise<void> {
  if (!hasFileSystemAccess || !dir) return
  try {
    await denoNs!.mkdir(dir, { recursive: true })
  } catch (err) {
    if (err && denoNs && err instanceof denoNs.errors.AlreadyExists) return
    throw err
  }
}

function createFileStorageAdapter(): FeedStorageAdapter {
  if (!hasFileSystemAccess) {
    throw new Error('filesystem access not available')
  }
  return {
    async readFile(dir, filename) {
      try {
        return await denoNs!.readTextFile(pathJoin(dir, filename))
      } catch (err) {
        if (err && denoNs && err instanceof denoNs.errors.NotFound) return null
        throw err
      }
    },
    async writeFile(dir, filename, data) {
      await ensureDir(dir)
      await denoNs!.writeTextFile(pathJoin(dir, filename), data)
    },
    async appendFile(dir, filename, data) {
      await ensureDir(dir)
      await denoNs!.writeTextFile(pathJoin(dir, filename), data, { append: true })
    }
  }
}

function openIndexedDb(factory: NonNullable<IDBFactoryType>): Promise<IDBDatabaseType> {
  return new Promise((resolve, reject) => {
    try {
      const request = factory.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(LOG_STORE)) {
          db.createObjectStore(LOG_STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
    } catch (err) {
      reject(err)
    }
  })
}

function runRead<T>(db: IDBDatabaseType, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readonly')
    const store = tx.objectStore(LOG_STORE)
    const request = store.get(key) as IDBRequestType<T | undefined>
    request.onsuccess = () => {
      resolve(request.result as T | undefined)
    }
    request.onerror = () => {
      reject(request.error ?? tx.error ?? new Error('indexedDB read failed'))
    }
  })
}

function runWrite(db: IDBDatabaseType, key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readwrite')
    const store = tx.objectStore(LOG_STORE)
    const request = store.put(value, key) as IDBRequestType
    request.onerror = () => {
      reject(request.error ?? tx.error ?? new Error('indexedDB write failed'))
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('indexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'))
  })
}

function runAppend(db: IDBDatabaseType, key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readwrite')
    const store = tx.objectStore(LOG_STORE)
    const request = store.get(key) as IDBRequestType<string | undefined>
    request.onerror = () => {
      reject(request.error ?? tx.error ?? new Error('indexedDB read failed'))
    }
    request.onsuccess = () => {
      try {
        const prev = typeof request.result === 'string' ? request.result : ''
        const putReq = store.put(prev + value, key) as IDBRequestType
        putReq.onerror = () => reject(putReq.error ?? tx.error ?? new Error('indexedDB append failed'))
      } catch (err) {
        reject(err)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('indexedDB append transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB append transaction aborted'))
  })
}

async function createIndexedDbAdapter(): Promise<FeedStorageAdapter> {
  if (!indexedDbFactory) {
    throw new Error('indexedDB not available')
  }
  const db = await openIndexedDb(indexedDbFactory)
  return {
    async readFile(dir, filename) {
      const key = storageKey(dir, filename)
      const value = await runRead<string>(db, key)
      return typeof value === 'string' ? value : null
    },
    async writeFile(dir, filename, data) {
      const key = storageKey(dir, filename)
      await runWrite(db, key, data)
    },
    async appendFile(dir, filename, data) {
      const key = storageKey(dir, filename)
      await runAppend(db, key, data)
    }
  }
}

export function createMemoryStorageAdapter(): FeedStorageAdapter {
  const store = new Map<string, string>()
  return {
    async readFile(dir, filename) {
      return store.get(storageKey(dir, filename)) ?? null
    },
    async writeFile(dir, filename, data) {
      store.set(storageKey(dir, filename), data)
    },
    async appendFile(dir, filename, data) {
      const key = storageKey(dir, filename)
      const prev = store.get(key) ?? ''
      store.set(key, prev + data)
    }
  }
}

async function resolveDefaultAdapter(): Promise<FeedStorageAdapter> {
  if (storageOverride) return storageOverride
  if (hasFileSystemAccess) {
    if (!fileAdapter) fileAdapter = createFileStorageAdapter()
    return fileAdapter
  }
  if (indexedDbFactory) {
    if (!indexedDbAdapterPromise) {
      indexedDbAdapterPromise = createIndexedDbAdapter().catch(err => {
        console.error('failed to init indexedDB adapter', err)
        return createMemoryStorageAdapter()
      })
    }
    return indexedDbAdapterPromise
  }
  return createMemoryStorageAdapter()
}

export function setFeedStorageAdapter(adapter: FeedStorageAdapter | null): void {
  storageOverride = adapter
  defaultAdapterPromise = null
}

export async function getFeedStorageAdapter(): Promise<FeedStorageAdapter> {
  if (storageOverride) return storageOverride
  if (!defaultAdapterPromise) {
    defaultAdapterPromise = resolveDefaultAdapter()
  }
  return defaultAdapterPromise
}
