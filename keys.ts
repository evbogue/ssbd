import { generate, KeyJSON } from './keygen.ts'
import { parseArgs } from "https://deno.land/std@0.207.0/cli/parse_args.ts"
import { join } from "https://deno.land/std@0.207.0/path/mod.ts"
const SECRET_FILENAME = 'secret'
const DIR_ENV = Deno.env.get('SSBD_DIR')
const HOME = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || ''
export const DEFAULT_KEY_DIR = DIR_ENV || join(HOME || '.', '.ssbd')

function constructKeyFile(keys: KeyJSON): string {
  return `# WARNING: Never show this to anyone.
# WARNING: Never edit it or use it on multiple devices at once.
#
# This is your SECRET, it gives you magical powers. With your secret you can
# sign your messages so that your friends can verify that the messages came
# from you. If anyone learns your secret, they can use it to impersonate you.
#
# If you use this secret on more than one device you will create a fork and
# your friends will stop replicating your content.
#
${JSON.stringify(keys, null, 2)}
#
# The only part of this file that's safe to share is your public name:
#
#   ${keys.id}`
}

function reconstructKeys(text: string): KeyJSON {
  const privateKey = text
    .replace(/\s*\#[^\n]*/g, '')
    .split('\n')
    .filter(function (line) {
      return !!line
    })
    .join('')
  const parsed = JSON.parse(privateKey) as KeyJSON
  if (!parsed.id || parsed.id[0] !== '@') parsed.id = '@' + parsed.public
  return parsed
}

function secretPath(dir: string): string {
  return join(dir, SECRET_FILENAME)
}

async function readKeys(dir: string): Promise<KeyJSON> {
  const text = await Deno.readTextFile(secretPath(dir))
  return reconstructKeys(text)
}

async function ensureDir(dir: string) {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 })
}

async function writeKeys(dir: string, keys: KeyJSON): Promise<void> {
  await ensureDir(dir)
  await Deno.writeTextFile(secretPath(dir), constructKeyFile(keys), { createNew: true, mode: 0o600 })
}

export async function loadOrCreateKeys(dir: string = DEFAULT_KEY_DIR): Promise<KeyJSON> {
  try {
    return await readKeys(dir)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      const keys = await generate()
      await writeKeys(dir, keys)
      return keys
    }
    throw err
  }
}

if (import.meta.main) {
  const parsedArgs = parseArgs(Deno.args);
  const dir = parsedArgs.dir as string | undefined;
  const printKeys = parsedArgs['print-keys'] as boolean | undefined;

  loadOrCreateKeys(dir || DEFAULT_KEY_DIR)
    .then(keys => {
      if (printKeys) console.log(JSON.stringify(keys))
      else console.log('deno ssb server using key', keys.id)
    })
    .catch(err => {
      console.error('failed to load keys', err)
      Deno.exit(1)
    })
}
