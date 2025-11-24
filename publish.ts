import { parseArgs } from "jsr:@std/cli/parse-args"
import { appendContent } from './feed.ts'
import { DEFAULT_KEY_DIR, loadOrCreateKeys } from './keys.ts'

interface PublishOptions {
  dir?: string
  help?: boolean
  [key: string]: unknown
}

function parseCli(args: string[]): PublishOptions {
  return parseArgs(args, {
    string: ['dir', 'type', 'text'],
    alias: {
      dir: ['d']
    },
    '--': true
  }) as PublishOptions
}

function printUsage() {
  console.log('Usage: deno run --allow-read --allow-write deno-ssb/publish.ts [--dir path] --type <type> [--text "hello"] [--key value ...]')
  console.log('')
  console.log('Matches the classic `sbot publish` format: flags become keys on the message content.')
  console.log('Examples:')
  console.log('  deno run --allow-read --allow-write deno-ssb/publish.ts --type post --text "hello world"')
  console.log('  deno run --allow-read --allow-write deno-ssb/publish.ts --type about --about @alice --name "Alice"')
}

function buildContent(opts: PublishOptions): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(opts)) {
    if (key === '_' || key === 'dir' || key === 'help') continue
    if (value == null) continue
    if (Array.isArray(value)) {
      if (value.length === 1) {
        content[key] = value[0]
      } else {
        content[key] = value
      }
    } else {
      content[key] = value
    }
  }
  if (typeof content.type !== 'string' || !content.type.length) {
    throw new Error('publish requires a --type argument')
  }
  return content
}

;(async () => {
  const parsed = parseCli(Deno.args)
  if (parsed.help) {
    printUsage()
    return
  }
  const dir = typeof parsed.dir === 'string' && parsed.dir.length ? parsed.dir : DEFAULT_KEY_DIR
  try {
    const content = buildContent(parsed)
    const keys = await loadOrCreateKeys(dir)
    const entry = await appendContent(dir, keys, content)
    console.log(JSON.stringify(entry, null, 2))
  } catch (err) {
    console.error('failed to publish', err instanceof Error ? err.message : err)
    Deno.exit(1)
  }
})()
