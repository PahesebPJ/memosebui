#!/usr/bin/env node
// Fails when the version drifts between the npm package and the desktop shell.
// tauri.conf.json reads its version from ../package.json, so it cannot drift on its own.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')

const sources = {
  'package.json': JSON.parse(read('package.json')).version,
  'src/version.ts': read('src/version.ts').match(/export const VERSION = '([^']+)'/)?.[1],
  'src-tauri/Cargo.toml': read('src-tauri/Cargo.toml').match(/^\[package\][^[]*?^version = "([^"]+)"/ms)?.[1],
  // A stale lock breaks `cargo test --locked` in CI even when Cargo.toml was bumped.
  'src-tauri/Cargo.lock': read('src-tauri/Cargo.lock').match(/name = "memosebui-desktop"\r?\nversion = "([^"]+)"/)?.[1],
}

const tauriVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version
if (tauriVersion !== '../package.json') sources['src-tauri/tauri.conf.json'] = tauriVersion

const expected = sources['package.json']
const mismatches = Object.entries(sources).filter(([, v]) => v !== expected)

for (const [file, version] of Object.entries(sources)) {
  console.log(`${version === expected ? '✔' : '✘'} ${file}: ${version ?? '(not found)'}`)
}
if (mismatches.length > 0) {
  console.error(`\nVersion mismatch: expected ${expected} everywhere.`)
  process.exit(1)
}
