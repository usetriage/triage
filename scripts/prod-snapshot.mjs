// Installs the current checkout as the global `triage`, without releasing it.
//
// The tarball is labelled with a prerelease version — 1.0.4-dev.gabc1234, plus
// `.dirty` if the tree has uncommitted changes — so `triage status` never shows
// unreleased code under a release number. package.json is restored byte for byte
// afterwards, even if the build fails. Nothing is committed, tagged or published,
// and the daemon is not restarted: run `triage restart` yourself.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' })

const original = readFileSync('package.json', 'utf8')
const pkg = JSON.parse(original)
const [, major, minor, patch] = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/)
const dirty = git('status', '--porcelain') !== ''
const version = `${major}.${minor}.${Number(patch) + 1}-dev.g${git('rev-parse', '--short', 'HEAD')}${dirty ? '.dirty' : ''}`
const tarball = `${pkg.name}-${version}.tgz`

try {
  writeFileSync('package.json', JSON.stringify({ ...pkg, version }, null, 2) + '\n')
  run('npm', 'run', 'build')
  run('npm', 'pack')
  run('npm', 'i', '-g', `./${tarball}`)
} finally {
  writeFileSync('package.json', original)
  rmSync(tarball, { force: true })
}

console.log(`\ninstalled triage ${version} — run \`triage restart\` to switch over`)
