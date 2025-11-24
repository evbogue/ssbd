import { assertEquals } from "jsr:@std/assert/equals";
import { signValue, UnsignedValue } from './feed.ts'
import { generate } from './keygen.ts'

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const decoder = new TextDecoder()
  return decoder.decode(concatChunks(chunks))
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

async function startServeProcess(dir: string) {
  const port = 41000 + Math.floor(Math.random() * 1000)
  const command = new Deno.Command('deno', {
    args: [
      'run',
      '--quiet',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-net=127.0.0.1',
      'deno-ssb/serve.ts',
      '--dir',
      dir,
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ],
    stdout: 'null',
    stderr: 'piped'
  })
  const child = command.spawn()
  const baseUrl = `http://127.0.0.1:${port}`
  const statusUrl = `${baseUrl}/status`
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(statusUrl)
      if (res.ok) {
        const info = await res.json()
        return { child, port, info }
      }
    } catch (_) {
      // ignore until server starts
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const stderrText = await readStream(child.stderr)
  await stopServeProcess(child)
  throw new Error('server failed to start: ' + stderrText)
}

async function stopServeProcess(proc: { kill: (signal?: Deno.Signal) => void; status: Promise<Deno.CommandStatus> }) {
  try {
    proc.kill('SIGTERM')
  } catch (_) {}
  try {
    await proc.status
  } catch (_) {}
}

Deno.test('serve publishes and exposes log entries', async () => {
  let netAvailable = true
  try {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 })
    listener.close()
  } catch (_) {
    netAvailable = false
  }
  if (!netAvailable) {
    console.warn('net listen not permitted; skipping serve integration test')
    return
  }
  const dir = await Deno.makeTempDir()
  const { child, port } = await startServeProcess(dir)
  const url = `http://127.0.0.1:${port}`
  try {
    const keys = await generate()
    const unsigned: UnsignedValue = {
      previous: null,
      author: keys.id,
      sequence: 1,
      timestamp: Date.now(),
      hash: 'sha256',
      content: { type: 'post', text: 'hello via http' }
    }
    const signed = await signValue(keys, unsigned)
    const publishRes = await fetch(url + '/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg: signed })
    })
    assertEquals(publishRes.status, 200)

    const logRes = await fetch(url + '/log.json')
    assertEquals(logRes.status, 200)
    const entries = await logRes.json()
    assertEquals(Array.isArray(entries), true)
    assertEquals(entries.length >= 1, true)
  } finally {
    await stopServeProcess(child)
  }
})
