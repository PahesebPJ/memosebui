#!/usr/bin/env node
// Exercises the real SEA binary the way the Tauri shell does: no Node on PATH, wait for the
// ready line, hit the HTML, API and the embedded stylesheet asset, then close stdin and expect
// a clean exit. `--version` alone would not catch a broken SEA asset or sidecar mode.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const binary = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  console.error('usage: node scripts/smoke-sidecar.mjs <path-to-memosebui-server-binary>')
  process.exit(2)
}

const home = mkdtempSync(path.join(os.tmpdir(), 'memosebui-smoke-'))
const cwd = mkdtempSync(path.join(os.tmpdir(), 'memosebui-smoke-cwd-'))
// The vault lives in the platform data dir under HOME; nothing may be created in the cwd.
const expectedVault =
  process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local', 'memoseb', 'vault.sqlite')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'memoseb', 'vault.sqlite')
      : path.join(home, '.local', 'share', 'memoseb', 'vault.sqlite')
const child = spawn(binary, ['sidecar'], {
  cwd,
  env: { HOME: home, USERPROFILE: home, PATH: '', SystemRoot: process.env.SystemRoot ?? '' },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const fail = (message) => {
  console.error(`✘ ${message}`)
  child.kill()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  process.exit(1)
}

const ready = await new Promise((resolve) => {
  let buffer = ''
  const timer = setTimeout(() => fail('no ready line within 30 s'), 30_000)
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    clearTimeout(timer)
    resolve(JSON.parse(buffer.slice(0, newline)))
  })
  child.once('exit', (code) => fail(`sidecar exited early with code ${code}`))
})
child.removeAllListeners('exit')
console.log(`✔ ready at ${ready.url}`)

for (const [route, type, pattern] of [
  ['/', 'text/html', /memosebui/],
  ['/api/health', 'application/json', /"status":"ok"/],
  ['/api/graph', 'application/json', /"nodes"/],
  ['/styles/mind.css', 'text/css', /data-theme="dark"/],
]) {
  const res = await fetch(`${ready.url}${route}`)
  const body = await res.text()
  if (res.status !== 200) fail(`${route} -> HTTP ${res.status}`)
  if (!(res.headers.get('content-type') ?? '').includes(type)) fail(`${route} -> wrong content-type`)
  if (!pattern.test(body)) fail(`${route} -> unexpected body`)
  console.log(`✔ ${route} (${body.length} B)`)
}

const exitCode = new Promise((resolve) => child.once('exit', resolve))
child.stdin.end()
const timer = setTimeout(() => fail('sidecar did not exit within 5 s of stdin closing'), 5_000)
const code = await exitCode
clearTimeout(timer)
if (code !== 0) fail(`exit code ${code}`)
console.log('✔ clean exit after stdin closed')
if (!existsSync(expectedVault)) fail(`vault not created at ${expectedVault}`)
if (readdirSync(cwd).length > 0) fail(`sidecar wrote into its cwd: ${readdirSync(cwd).join(', ')}`)
console.log('✔ vault in the platform data dir, cwd untouched')
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
