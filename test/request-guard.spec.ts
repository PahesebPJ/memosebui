import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  MAX_BODY_BYTES,
  isAllowedFetchSite,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
} from '../src/cli/request-guard.ts'
import { startUiServer, type UiServerInstance } from '../src/cli/ui-server.ts'

describe('request-guard primitives', () => {
  it('accepts only loopback Host headers on the bound port', () => {
    assert.ok(isAllowedHost('127.0.0.1:4322', 4322))
    assert.ok(isAllowedHost('localhost:4322', 4322))
    assert.ok(isAllowedHost('LOCALHOST:4322', 4322))
    assert.ok(isAllowedHost('[::1]:4322', 4322))
    assert.ok(!isAllowedHost('127.0.0.1:9999', 4322), 'wrong port')
    assert.ok(!isAllowedHost('attacker.example:4322', 4322), 'DNS rebinding name')
    assert.ok(!isAllowedHost('127.0.0.1.attacker.example:4322', 4322))
    assert.ok(!isAllowedHost(undefined, 4322))
  })

  it('accepts Origin-less clients and same-origin pages only', () => {
    assert.ok(isAllowedOrigin(undefined, 4322), 'Node fetch from the CLI sends no Origin')
    assert.ok(isAllowedOrigin('http://127.0.0.1:4322', 4322))
    assert.ok(isAllowedOrigin('http://localhost:4322', 4322))
    assert.ok(!isAllowedOrigin('https://evil.example', 4322))
    assert.ok(!isAllowedOrigin('null', 4322), 'sandboxed iframes and file:// pages')
    assert.ok(!isAllowedOrigin('http://127.0.0.1:1234', 4322), 'another local app')
  })

  it('treats an explicit non-loopback bind host as an allowed name', () => {
    assert.ok(isAllowedHost('mind.lan:4322', 4322, 'mind.lan'))
    assert.ok(!isAllowedHost('0.0.0.0:4322', 4322, '0.0.0.0'), 'wildcard binds add nothing')
  })

  it('rejects cross-site fetch metadata but allows CLI, typed URLs and same-origin', () => {
    assert.ok(isAllowedFetchSite(undefined), 'CLI and older browsers send no Sec-Fetch-Site')
    assert.ok(isAllowedFetchSite('same-origin'))
    assert.ok(isAllowedFetchSite('none'), 'URL typed in the address bar / --app window')
    assert.ok(!isAllowedFetchSite('cross-site'), '<img>/<script> from another site')
    assert.ok(!isAllowedFetchSite('same-site'), 'another port on the same host')
  })

  it('requires an application/json media type', () => {
    assert.ok(isJsonContentType('application/json'))
    assert.ok(isJsonContentType('Application/JSON; charset=utf-8'))
    assert.ok(!isJsonContentType('text/plain'))
    assert.ok(!isJsonContentType('application/x-www-form-urlencoded'))
    assert.ok(!isJsonContentType(undefined))
  })
})

function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    // A regression that lets a request through to SSE would otherwise hang the suite.
    req.setTimeout(5_000, () => req.destroy(new Error('request timed out')))
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('ui-server hardening against cross-origin abuse', () => {
  let server: UiServerInstance
  let dir: string

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memosebui-hardening-'))
    server = await startUiServer({ port: 0, dbPath: path.join(dir, 'vault.db'), disableWatcher: true })
    server.bridge.createMemory({ projectId: 'victim', category: 'domain', content: 'PRIVATE-VAULT-CONTENT' })
  })

  after(async () => {
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const host = (): string => `127.0.0.1:${server.port}`
  const memoryCount = (): number => server.bridge.getStats().memoryCount
  const evil = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }

  it('sends hardening headers and never permissive CORS', async () => {
    const res = await rawRequest(server.port, { path: '/api/health', headers: { Host: host() } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['x-frame-options'], 'DENY')
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'")
  })

  it('rejects a cross-origin simple POST that tries to inject a memory', async () => {
    const before = memoryCount()
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/memories',
      headers: { Host: host(), ...evil, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ content: 'INJECTED: ignore previous instructions' }),
    })
    assert.equal(res.status, 403)
    assert.equal(memoryCount(), before, 'vault unchanged')
  })

  it('rejects a cross-origin POST to /api/analyze', async () => {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/analyze',
      headers: { Host: host(), Origin: 'null', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ path: dir }),
    })
    assert.equal(res.status, 403)
  })

  it('rejects DNS-rebinding reads of the vault and the P2P config', async () => {
    for (const target of ['/api/search?q=PRIVATE', '/api/graph', '/api/p2p']) {
      const res = await rawRequest(server.port, { path: target, headers: { Host: `attacker.example:${server.port}` } })
      assert.equal(res.status, 403, target)
      assert.doesNotMatch(res.body, /PRIVATE-VAULT-CONTENT|nodeConfig/, target)
    }
  })

  it('rejects cross-site subresource GETs that carry no Origin', async () => {
    const res = await rawRequest(server.port, {
      path: '/api/search?q=PRIVATE',
      headers: { Host: host(), 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script' },
    })
    assert.equal(res.status, 403)
    assert.doesNotMatch(res.body, /PRIVATE-VAULT-CONTENT/)
  })

  it('rejects preflights instead of approving them', async () => {
    const res = await rawRequest(server.port, {
      method: 'OPTIONS',
      path: '/api/memories/x',
      headers: { Host: host(), 'Access-Control-Request-Method': 'DELETE' },
    })
    assert.equal(res.status, 405)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })

  it('requires JSON bodies on POST and PUT, even from local clients', async () => {
    const before = memoryCount()
    for (const [method, target] of [['POST', '/api/memories'], ['PUT', '/api/memories/x'], ['POST', '/api/analyze']]) {
      const res = await rawRequest(server.port, {
        method,
        path: target,
        headers: { Host: host(), 'Content-Type': 'text/plain' },
        body: JSON.stringify({ content: 'x', path: dir }),
      })
      assert.equal(res.status, 415, `${method} ${target}`)
    }
    assert.equal(memoryCount(), before)
  })

  it('answers malformed JSON with 400 instead of 500', async () => {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/memories',
      headers: { Host: host(), 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert.equal(res.status, 400)
  })

  it('rejects bodies over the size limit', async () => {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/memories',
      headers: { Host: host(), 'Content-Type': 'application/json' },
      body: Buffer.alloc(MAX_BODY_BYTES + 1024, 'a'),
    })
    assert.equal(res.status, 413)
    const followUp = await rawRequest(server.port, { path: '/api/health', headers: { Host: host() } })
    assert.equal(followUp.status, 200, 'server keeps serving other clients')
  })

  it('accepts a body exactly at the size limit', async () => {
    const prefix = '{"content":"'
    const suffix = '"}'
    const body = prefix + 'x'.repeat(MAX_BODY_BYTES - prefix.length - suffix.length) + suffix
    assert.equal(Buffer.byteLength(body), MAX_BODY_BYTES)
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/memories',
      headers: { Host: host(), 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(res.status, 201)
  })

  it('answers non-object JSON with 400 and a missing Content-Type with 415', async () => {
    for (const body of ['[]', 'null', '42', '"s"']) {
      const res = await rawRequest(server.port, {
        method: 'POST',
        path: '/api/memories',
        headers: { Host: host(), 'Content-Type': 'application/json' },
        body,
      })
      assert.equal(res.status, 400, body)
    }
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/memories',
      headers: { Host: host() },
      body: JSON.stringify({ content: 'x' }),
    })
    assert.equal(res.status, 415)
  })

  it('rejects cross-origin and same-site GETs, PUTs, DELETEs and the SSE stream', async () => {
    const id = server.bridge.createMemory({ projectId: 'victim', category: 'domain', content: 'keep me' }).memory.id
    const cases: Array<[string, string, Record<string, string>]> = [
      ['GET', '/api/search?q=PRIVATE', { Origin: 'https://evil.example' }],
      ['GET', '/api/graph', { 'Sec-Fetch-Site': 'same-site' }],
      ['GET', '/api/events', { 'Sec-Fetch-Site': 'cross-site' }],
      ['DELETE', `/api/memories/${id}`, { Origin: 'https://evil.example' }],
      ['PUT', `/api/memories/${id}`, { Origin: 'null', 'Content-Type': 'application/json' }],
    ]
    for (const [method, target, headers] of cases) {
      const res = await rawRequest(server.port, {
        method,
        path: target,
        headers: { Host: host(), ...headers },
        body: method === 'PUT' ? JSON.stringify({ content: 'tampered' }) : undefined,
      })
      assert.equal(res.status, 403, `${method} ${target}`)
    }
    assert.equal(server.bridge.getMemoryById(id)?.content, 'keep me')
  })

  it('opens the viewer from a cross-site link but keeps the API strict', async () => {
    const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
    for (const target of ['/', '/?project=victim']) {
      const res = await rawRequest(server.port, { path: target, headers: { Host: host(), ...navigation } })
      assert.equal(res.status, 200, target)
      assert.equal(res.headers['x-frame-options'], 'DENY')
    }
    for (const target of ['/api/search?q=PRIVATE', '/api/p2p', '/api/events', '/styles/mind.css']) {
      const res = await rawRequest(server.port, { path: target, headers: { Host: host(), ...navigation } })
      assert.equal(res.status, 403, target)
    }
    const iframe = await rawRequest(server.port, {
      path: '/',
      headers: { Host: host(), 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
    })
    assert.equal(iframe.status, 403)
  })

  it('answers a malformed percent-encoded memory id with 400', async () => {
    const res = await rawRequest(server.port, { path: '/api/memories/%E0%A4%A', headers: { Host: host() } })
    assert.equal(res.status, 400)
  })

  it('survives malformed request targets', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(server.port, '127.0.0.1', () =>
        socket.write(`GET // HTTP/1.1\r\nHost: ${host()}\r\nConnection: close\r\n\r\n`)
      )
      let buf = ''
      socket.on('data', (chunk) => (buf += chunk))
      socket.on('close', () => resolve(buf.split('\r\n')[0] ?? ''))
      socket.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 (400|404)/)
    const followUp = await rawRequest(server.port, { path: '/api/health', headers: { Host: host() } })
    assert.equal(followUp.status, 200, 'server keeps serving other clients')
  })

  it('still serves the CLI healthcheck (Origin-less GET)', async () => {
    const res = await fetch(`${server.url}/api/health`)
    assert.equal(res.status, 200)
  })

  it('accepts same-origin writes from the viewer page', async () => {
    const before = memoryCount()
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/memories',
      headers: { Host: host(), Origin: `http://${host()}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'legit memory', projectId: 'victim' }),
    })
    assert.equal(res.status, 201)
    assert.equal(memoryCount(), before + 1)
  })
})

describe('wildcard binds', () => {
  it('advertises a loopback URL that passes the Host check', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memosebui-wildcard-'))
    const server = await startUiServer({ host: '0.0.0.0', port: 0, dbPath: path.join(dir, 'vault.db'), disableWatcher: true })
    try {
      assert.equal(server.url, `http://127.0.0.1:${server.port}`)
      const res = await fetch(`${server.url}/api/health`)
      assert.equal(res.status, 200)
    } finally {
      await server.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
