#!/usr/bin/env node
/**
 * Fixtures for the plugin e2e specs: the `echo` test plugin
 * (services/plugin_runner/tests/fixtures/plugins/echo) as installable archives, with a
 * catalog and an Ed25519 signature that cover them, for "Install from file".
 *
 * The signing key is a throwaway development key, created on the first run and kept in
 * the output folder (gitignored) so the stack can be told to trust it once: the script
 * prints the PLUGINS_EXTRA_TRUSTED_KEYS value to put in .env before `./redamon.sh up`.
 * Never use it for anything else.
 *
 *   node scripts/make-plugin-fixtures.mjs [outDir]     (default .plugin-fixtures, gitignored;
 *   not test-results/, which Playwright empties at the start of every run)
 *
 * Releases: echo 1.0.0 (data version 1) and 1.1.0 (data version 2, migrations/0002_*).
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ECHO = resolve(HERE, '../../../services/plugin_runner/tests/fixtures/plugins/echo')
const OUT = resolve(process.argv[2] ?? join(HERE, '..', '.plugin-fixtures'))
const RELEASES = [
  { version: '1.0.0', dataVersion: 1 },
  { version: '1.1.0', dataVersion: 2 },
]
const BLOCK = 512

function key() {
  const file = join(OUT, 'dev-key.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const k = {
    keyId: `e2e-dev-${Date.now().toString(36)}`,
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
  writeFileSync(file, JSON.stringify(k, null, 2))
  chmodSync(file, 0o600)
  return k
}

function files(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (name === '__pycache__' || name.endsWith('.pyc')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push({ dir: true, path: p }, ...files(p))
    else out.push({ dir: false, path: p })
  }
  return out
}

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

/** One POSIX ustar header: the strict reader of the platform accepts nothing else. */
function header(name, size, isDir) {
  const h = Buffer.alloc(BLOCK, 0)
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 1 - (isDir ? 1 : 0))
    prefix = name.slice(0, cut)
    name = name.slice(cut + 1)
  }
  h.write(name, 0, 100, 'utf8')
  h.write(octal(isDir ? 0o755 : 0o644, 8), 100, 'latin1')
  h.write(octal(0, 8), 108, 'latin1')
  h.write(octal(0, 8), 116, 'latin1')
  h.write(octal(size, 12), 124, 'latin1')
  h.write(octal(1767225600, 12), 136, 'latin1')
  h.fill(0x20, 148, 156)
  h.write(isDir ? '5' : '0', 156, 'latin1')
  h.write('ustar\0', 257, 'latin1')
  h.write('00', 263, 'latin1')
  h.write('root', 265, 'latin1')
  h.write('root', 297, 'latin1')
  h.write(octal(0, 8), 329, 'latin1')
  h.write(octal(0, 8), 337, 'latin1')
  h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return h
}

function archive(release) {
  const parts = [header('echo/', 0, true)]
  for (const f of files(ECHO)) {
    const rel = `echo/${relative(ECHO, f.path).split('\\').join('/')}`
    if (f.dir) {
      parts.push(header(`${rel}/`, 0, true))
      continue
    }
    let bytes = readFileSync(f.path)
    if (rel === 'echo/plugin.json') {
      const m = JSON.parse(bytes.toString('utf8'))
      bytes = Buffer.from(JSON.stringify({ ...m, version: release.version, dataVersion: release.dataVersion }, null, 2))
    }
    parts.push(header(rel, bytes.length, false), bytes)
    const rem = bytes.length % BLOCK
    if (rem) parts.push(Buffer.alloc(BLOCK - rem, 0))
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0))
  return gzipSync(Buffer.concat(parts))
}

mkdirSync(OUT, { recursive: true })
const k = key()
const manifest = JSON.parse(readFileSync(join(ECHO, 'plugin.json'), 'utf8'))
const releases = RELEASES.map((r) => {
  const bytes = archive(r)
  const file = `echo-${r.version}.tar.gz`
  writeFileSync(join(OUT, file), bytes)
  return {
    version: r.version,
    platform: manifest.platform,
    dataVersion: r.dataVersion,
    url: `https://github.com/example/redamon-plugins/releases/download/echo-v${r.version}/${file}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    permissions: manifest.permissions,
  }
})
// A serial that only grows, so a fresh run is never taken for a replay of an older one.
const catalog = {
  catalogVersion: 1,
  serial: Math.floor(Date.now() / 1000),
  expires: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  plugins: [{ id: 'echo', displayName: manifest.displayName, description: manifest.description, releases }],
  revoked: [],
}
const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n')
writeFileSync(join(OUT, 'catalog.json'), bytes)
const sig = sign(null, bytes, createPrivateKey(k.privatePem)).toString('base64')
writeFileSync(join(OUT, 'catalog.json.sig'), JSON.stringify({ keyId: k.keyId, sig }) + '\n')
process.stdout.write(JSON.stringify({
  dir: OUT,
  releases: releases.map((r) => r.version),
  PLUGINS_EXTRA_TRUSTED_KEYS: JSON.stringify([{ keyId: k.keyId, publicKey: k.publicKey }]),
}, null, 2) + '\n')
