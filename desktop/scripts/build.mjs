// Builds Triage.app: root build → stage the usetriage package with its prod
// deps → fetch an official Node → compile the Electron main → icon →
// electron-builder (dir) → ad-hoc sign → zip (and optionally a dmg).
//
//   node scripts/build.mjs [--arch arm64|x64] [--skip-root-build] [--dmg]
//
// Idempotent: prod node_modules are reinstalled only when the lockfile or the
// arch changes, the Node tarball is cached under .cache/, and the icon is
// rebuilt only when the master PNG changes.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIcon } from './icon.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '..')
const stage = path.join(desktop, '.stage')
const cache = path.join(desktop, '.cache')
const stageTriage = path.join(stage, 'triage')
const stageNode = path.join(stage, 'node')

// ---- args

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}
const arch = option('--arch') ?? process.arch
if (arch !== 'arm64' && arch !== 'x64') die(`--arch must be arm64 or x64, got ${arch}`)
if (process.platform !== 'darwin') die('Triage.app builds on macOS only')

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

// ---- log helpers

const bold = (s) => `\x1b[1m${s}\x1b[22m`
const dim = (s) => `\x1b[2m${s}\x1b[22m`
const green = (s) => `\x1b[32m${s}\x1b[39m`
const STEPS = 8
let stepNo = 0
let stepStart = 0

function step(title) {
  if (stepNo) console.log(dim(`  done in ${((Date.now() - stepStart) / 1000).toFixed(1)}s`))
  stepNo++
  stepStart = Date.now()
  console.log(`\n${bold(`[${stepNo}/${STEPS}] ${title}`)}`)
}

const note = (s) => console.log(`  ${s}`)
const rel = (p) => path.relative(process.cwd(), p) || '.'

function die(msg) {
  console.error(`\nbuild failed: ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  note(dim(`$ ${cmd} ${args.join(' ')}`))
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) die(`${cmd} ${args[0] ?? ''} exited with ${r.status ?? r.signal}`)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function humanSize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function dirSize(dir) {
  return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]) * 1024
}

console.log(bold(`Triage.app ${version} · mac-${arch}`))

// ---- 1. root build

step('root build')
if (flag('--skip-root-build') && existsSync(path.join(root, 'dist/server/cli.js'))) {
  note('skipped (--skip-root-build), reusing dist/')
} else {
  run('npm', ['run', 'build'], { cwd: root })
}

// ---- 2. stage the server: exactly the published package + prod deps

step('stage server → .stage/triage')
{
  // npm pack gives exactly what `npm publish` ships (package.json "files").
  const packDir = mkdtempSync(path.join(os.tmpdir(), 'triage-pack-'))
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: root, encoding: 'utf8' }))
  const tgz = path.join(packDir, packed[0].filename)
  execFileSync('tar', ['-xzf', tgz, '-C', packDir])
  mkdirSync(stageTriage, { recursive: true })
  for (const entry of readdirSync(stageTriage)) {
    if (entry !== 'node_modules') rmSync(path.join(stageTriage, entry), { recursive: true, force: true })
  }
  cpSync(path.join(packDir, 'package'), stageTriage, { recursive: true })
  rmSync(packDir, { recursive: true, force: true })
  note(`${packed[0].filename} · ${packed[0].entryCount} files`)

  // Reinstall prod deps only when the lockfile or the arch changed.
  const lock = readFileSync(path.join(root, 'package-lock.json'))
  const key = `${sha256(lock)}-darwin-${arch}`
  const marker = path.join(stageTriage, 'node_modules/.triage-stage')
  if (existsSync(marker) && readFileSync(marker, 'utf8') === key) {
    note('node_modules up to date')
  } else {
    writeFileSync(path.join(stageTriage, 'package-lock.json'), lock)
    // --os/--cpu pick the target's optional deps (the Agent SDK's native
    // claude binary); --ignore-scripts because node-pty's install only checks
    // for its prebuild and the package's own postinstall is run below.
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--os=darwin', `--cpu=${arch}`], { cwd: stageTriage })
    rmSync(path.join(stageTriage, 'package-lock.json'))
    run(process.execPath, ['scripts/postinstall.mjs'], { cwd: stageTriage })
    prune(arch)
    writeFileSync(marker, key)
  }
  note(`${rel(stageTriage)} · ${humanSize(dirSize(stageTriage))}`)
}

// Drop what can never load on this target: node-pty's prebuilds for other
// platforms and its C++ sources (it loads prebuilds/<platform>-<arch> only).
function prune(target) {
  const pty = path.join(stageTriage, 'node_modules/node-pty')
  const keep = `darwin-${target}`
  for (const dir of readdirSync(path.join(pty, 'prebuilds'))) {
    if (dir !== keep) rmSync(path.join(pty, 'prebuilds', dir), { recursive: true, force: true })
  }
  for (const dir of ['deps', 'third_party', 'src']) rmSync(path.join(pty, dir), { recursive: true, force: true })
  if (!existsSync(path.join(pty, 'prebuilds', keep, 'pty.node'))) die(`node-pty has no prebuild for ${keep}`)
  const sdkBin = path.join(stageTriage, `node_modules/@anthropic-ai/claude-agent-sdk-darwin-${target}/claude`)
  if (!existsSync(sdkBin)) die(`the Agent SDK's native binary for darwin-${target} was not installed`)
  note(`pruned node-pty to ${keep}`)
}

// ---- 3. fetch Node 22 LTS

step('Node runtime → .stage/node')
{
  const nodeCache = path.join(cache, 'node')
  mkdirSync(nodeCache, { recursive: true })
  const nodeVersion = await latestNode22(nodeCache)
  const name = `node-${nodeVersion}-darwin-${arch}`
  const tarball = path.join(nodeCache, `${name}.tar.gz`)
  const marker = path.join(stageNode, '.version')

  if (existsSync(marker) && readFileSync(marker, 'utf8') === name && existsSync(path.join(stageNode, 'bin/node'))) {
    note(`${name} already staged`)
  } else {
    const sums = await cached(path.join(nodeCache, `SHASUMS256-${nodeVersion}.txt`), `https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`)
    const expected = sums.toString('utf8').split('\n').find((l) => l.endsWith(`  ${name}.tar.gz`))?.split(/\s+/)[0]
    if (!expected) die(`no checksum for ${name}.tar.gz in SHASUMS256.txt`)
    let buf = existsSync(tarball) ? readFileSync(tarball) : null
    if (!buf || sha256(buf) !== expected) {
      note(`downloading ${name}.tar.gz`)
      buf = await download(`https://nodejs.org/dist/${nodeVersion}/${name}.tar.gz`)
      if (sha256(buf) !== expected) die(`checksum mismatch for ${name}.tar.gz`)
      writeFileSync(tarball, buf)
    } else {
      note(`using cached ${name}.tar.gz`)
    }
    note(`sha256 ok ${dim(expected.slice(0, 16) + '…')}`)

    // Extract into a fresh directory, then take only bin/node and the LICENSE.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'triage-node-'))
    execFileSync('tar', ['-xzf', tarball, '-C', tmp, `${name}/bin/node`, `${name}/LICENSE`])
    rmSync(stageNode, { recursive: true, force: true })
    mkdirSync(path.join(stageNode, 'bin'), { recursive: true })
    cpSync(path.join(tmp, name, 'bin/node'), path.join(stageNode, 'bin/node'))
    cpSync(path.join(tmp, name, 'LICENSE'), path.join(stageNode, 'LICENSE'))
    rmSync(tmp, { recursive: true, force: true })
    writeFileSync(marker, name)
  }
  try {
    const v = execFileSync(path.join(stageNode, 'bin/node'), ['-p', "process.version + ' ' + process.arch"], { encoding: 'utf8' }).trim()
    note(`bin/node → ${v}${arch !== process.arch ? dim(' (via Rosetta)') : ''}`)
  } catch {
    // A cross-arch binary can't run here without Rosetta.
    if (arch === process.arch) die('the staged node binary does not run')
    note(`bin/node staged ${dim('(not runnable on this host)')}`)
  }
}

// Newest v22 LTS from nodejs.org; offline, the newest tarball already cached.
async function latestNode22(nodeCache) {
  try {
    const index = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString('utf8'))
    const hit = index.find((r) => r.version.startsWith('v22.') && r.lts && r.files.includes(`osx-${arch}-tar`))
    if (!hit) die('no Node 22 LTS for this arch in index.json')
    note(`latest Node 22 LTS: ${hit.version}`)
    return hit.version
  } catch (err) {
    const local = readdirSync(nodeCache)
      .map((f) => f.match(new RegExp(`^node-(v22\\.[\\d.]+)-darwin-${arch}\\.tar\\.gz$`))?.[1])
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (!local.length) die(`can't reach nodejs.org and no cached Node 22 (${err.message})`)
    note(`nodejs.org unreachable, using cached ${local[0]}`)
    return local[0]
  }
}

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function cached(file, url) {
  if (existsSync(file)) return readFileSync(file)
  const buf = await download(url)
  writeFileSync(file, buf)
  return buf
}

// ---- 4. compile the Electron main

step('compile Electron main → dist/')
run('npm', ['run', 'compile'], { cwd: desktop })

// ---- 5. icon

step('icon → build/icon.icns')
{
  const { built } = buildIcon()
  note(built ? 'built from web/public/icon-1024.png' : 'up to date')
}

// ---- 6. electron-builder

step('electron-builder')
const outDir = path.join(desktop, 'release', arch === 'x64' ? 'mac' : `mac-${arch}`)
const app = path.join(outDir, 'Triage.app')
{
  const args = ['--mac', 'dir', `--${arch}`, '--publish', 'never', `-c.extraMetadata.version=${version}`]
  // Reuse the Electron that npm already installed when it matches the target.
  const localElectron = path.join(desktop, 'node_modules/electron/dist')
  if (arch === process.arch && existsSync(path.join(localElectron, 'Electron.app'))) {
    args.push(`-c.electronDist=${localElectron}`)
  }
  rmSync(outDir, { recursive: true, force: true })
  run(path.join(desktop, 'node_modules/.bin/electron-builder'), args, {
    cwd: desktop,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  })
  if (!existsSync(app)) die(`electron-builder did not produce ${rel(app)}`)
  // The npm-installed Electron still carries its "drop an app here" shell.
  rmSync(path.join(app, 'Contents/Resources/default_app.asar'), { force: true })
  // extraResources is filtered, so check the runtime actually made it in.
  for (const p of ['node/bin/node', 'triage/dist/server/cli.js', 'triage/node_modules/node-pty/package.json', 'triage/node_modules/@anthropic-ai/claude-agent-sdk/package.json']) {
    if (!existsSync(path.join(app, 'Contents/Resources', p))) die(`Resources/${p} is missing from the app`)
  }
}

// ---- 7. ad-hoc sign

step('ad-hoc sign')
{
  // `codesign --deep` only descends into nested bundles, not plain Mach-O
  // files under Resources (node, node-pty, the Agent SDK's claude). Anything
  // there without a valid signature is signed ad-hoc first; binaries that
  // already carry one (Node's and Anthropic's Developer ID) keep it.
  const machos = findMachO(path.join(app, 'Contents/Resources'))
  let signed = 0
  for (const file of machos) {
    if (spawnSync('codesign', ['--verify', '--strict', file], { stdio: 'ignore' }).status === 0) continue
    execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' })
    signed++
  }
  note(`${machos.length} Mach-O files under Resources · ${signed} signed ad-hoc · ${machos.length - signed} kept their signature`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8' })
  if (verify.status !== 0) die(`codesign --verify failed:\n${verify.stderr}`)
  note(`${green('✓')} codesign --verify --deep --strict`)
  const assess = spawnSync('spctl', ['--assess', '--type', 'execute', app], { encoding: 'utf8' })
  note(dim(`spctl: ${assess.status === 0 ? 'accepted' : 'rejected (expected: ad-hoc, no Developer ID)'}`))
}

function findMachO(dir) {
  const magics = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
  const out = []
  const head = Buffer.alloc(4)
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(p); continue }
      if (!st.isFile() || st.size < 4096) continue
      const fd = openSync(p, 'r')
      try { readSync(fd, head, 0, 4, 0) } finally { closeSync(fd) }
      if (magics.has(head.readUInt32BE(0))) out.push(p)
    }
  }
  walk(dir)
  return out
}

// ---- 8. zip (+ dmg)

step('package')
const zip = path.join(desktop, 'release', `Triage-${version}-mac-${arch}.zip`)
{
  // ditto keeps the framework symlinks and the signatures intact.
  rmSync(zip, { force: true })
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
}
let dmg = null
if (flag('--dmg')) {
  dmg = path.join(desktop, 'release', `Triage-${version}-mac-${arch}.dmg`)
  const src = mkdtempSync(path.join(os.tmpdir(), 'triage-dmg-'))
  run('ditto', [app, path.join(src, 'Triage.app')])
  symlinkSync('/Applications', path.join(src, 'Applications'))
  rmSync(dmg, { force: true })
  run('hdiutil', ['create', '-quiet', '-volname', 'Triage', '-srcfolder', src, '-ov', '-format', 'UDZO', dmg])
  rmSync(src, { recursive: true, force: true })
}
console.log(dim(`  done in ${((Date.now() - stepStart) / 1000).toFixed(1)}s`))

console.log(`\n${green('●')} ${bold(`Triage ${version} (mac-${arch})`)}`)
console.log(`  app  ${rel(app)}  ${dim(humanSize(dirSize(app)))}`)
console.log(`  zip  ${rel(zip)}  ${dim(humanSize(statSync(zip).size))}`)
if (dmg) console.log(`  dmg  ${rel(dmg)}  ${dim(humanSize(statSync(dmg).size))}`)
