import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { capabilitiesPacket, CONSUMES, PROVIDES, SIGNALS } from '../src/cli/setup.ts'
import { BUNDLE_ID, VERSION } from '../src/version.ts'

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli', 'memosebui.ts')

describe('hubseb/v1 capabilities contract', () => {
  it('builds the wire envelope hubseb doctor expects', () => {
    const packet = capabilitiesPacket()
    assert.equal(packet.protocol, 'hubseb/v1')
    assert.equal(packet.status, 'success')
    assert.deepEqual(packet.payload, {
      id: BUNDLE_ID,
      version: VERSION,
      provides: [...PROVIDES],
      consumes: [...CONSUMES],
      signals: [...SIGNALS],
    })
  })

  it('prints a single JSON line for "capabilities --json" and "ping --json"', () => {
    for (const action of ['capabilities', 'ping']) {
      const out = execFileSync(process.execPath, [CLI, action, '--json'], { encoding: 'utf8' }).trim()
      assert.equal(out.split('\n').length, 1, out)
      const packet = JSON.parse(out) as { protocol: string; status: string; action: string; payload: { id: string } }
      assert.deepEqual([packet.protocol, packet.status, packet.action, packet.payload.id], ['hubseb/v1', 'success', action, BUNDLE_ID])
    }
  })

  it('prints a human summary without --json', () => {
    const out = execFileSync(process.execPath, [CLI, 'capabilities'], { encoding: 'utf8' })
    assert.match(out, new RegExp(`^${BUNDLE_ID} v${VERSION.replace(/\./g, '\\.')} \\[provides: `))
  })
})
