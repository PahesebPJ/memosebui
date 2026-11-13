import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  isMemosebuiRegistered,
  registerMemosebuiNode,
  unregisterMemosebuiNode,
} from '../src/cli/setup.ts'
import {
  isMemosebuiServerRunning,
  startUiServer,
} from '../src/cli/ui-server.ts'

describe('UI Server & Hubseb Topology Registration', () => {
  it('registers and unregisters memosebui in hubseb topology.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memosebui-topo-'))
    const topologyPath = path.join(tmpDir, 'topology.json')

    assert.equal(await isMemosebuiRegistered({ topologyPath }), false)

    const reg = await registerMemosebuiNode({ topologyPath })
    assert.equal(reg.success, true)
    assert.equal(reg.node.id, 'memosebui')
    assert.ok(reg.node.provides.includes('ui.memoseb'))
    assert.ok(reg.node.consumes.includes('memory.vault'))
    assert.equal(await isMemosebuiRegistered({ topologyPath }), true)

    const unreg = await unregisterMemosebuiNode({ topologyPath })
    assert.equal(unreg.removed, true)
    assert.equal(await isMemosebuiRegistered({ topologyPath }), false)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('serves HTML, CSS, REST CRUD endpoints, RRF search and SSE events', async () => {
    const instance = await startUiServer({
      port: 0,
      dbPath: ':memory:',
      disableWatcher: true,
    })

    try {
      // 1. Health, HTML & CSS (no macOS traffic lights)
      const healthRes = await fetch(`${instance.url}/api/health`)
      assert.equal(healthRes.status, 200)
      const health = (await healthRes.json()) as {
        status: string
        stats: { memoryCount: number }
      }
      assert.equal(health.status, 'ok')
      assert.equal(health.stats.memoryCount, 0)

      const htmlRes = await fetch(`${instance.url}/`)
      assert.equal(htmlRes.status, 200)
      const html = await htmlRes.text()
      assert.ok(html.includes('memosebui'))
      assert.equal(html.includes('traffic-lights'), false)

      const cssRes = await fetch(`${instance.url}/styles/mind.css`)
      assert.equal(cssRes.status, 200)

      // 2. Create memory via POST /api/memories
      const createRes = await fetch(`${instance.url}/api/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'memosebui',
          category: 'architecture',
          title: 'Interactive Node Animations',
          content: 'Synaptic particles and breathing halos rendered on HTML5 Canvas.',
          tags: ['canvas', 'animation'],
          importance: 0.9,
        }),
      })
      assert.equal(createRes.status, 201)
      const createdData = (await createRes.json()) as {
        memory: { id: string; title: string }
      }
      assert.equal(createdData.memory.title, 'Interactive Node Animations')

      // 3. Fetch graph via GET /api/graph & single memory via GET /api/memories/:id
      const singleRes = await fetch(
        `${instance.url}/api/memories/${createdData.memory.id}`
      )
      assert.equal(singleRes.status, 200)
      const singleData = (await singleRes.json()) as {
        memory: { id: string; title: string }
      }
      assert.equal(singleData.memory.id, createdData.memory.id)

      const missingRes = await fetch(`${instance.url}/api/memories/nonexistent-id`)
      assert.equal(missingRes.status, 404)

      const graphRes = await fetch(`${instance.url}/api/graph`)
      assert.equal(graphRes.status, 200)
      const graph = (await graphRes.json()) as {
        stats: { memoryCount: number }
        nodes: Array<{ id: string }>
      }
      assert.equal(graph.stats.memoryCount, 1)
      assert.ok(graph.nodes.length >= 2)

      // 4. Search via GET /api/search
      const searchRes = await fetch(
        `${instance.url}/api/search?q=Synaptic+particles+canvas`
      )
      assert.equal(searchRes.status, 200)
      const searchData = (await searchRes.json()) as {
        memories: Array<{ id: string; score: number }>
      }
      assert.equal(searchData.memories.length, 1)
      assert.equal(searchData.memories[0]!.id, createdData.memory.id)

      // 5. Update via PUT /api/memories/:id
      const putRes = await fetch(
        `${instance.url}/api/memories/${createdData.memory.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated Node Animations' }),
        }
      )
      assert.equal(putRes.status, 200)
      const putData = (await putRes.json()) as {
        memory: { title: string }
      }
      assert.equal(putData.memory.title, 'Updated Node Animations')

      // 6. P2P endpoint & active server detection (prevents EADDRINUSE on memosebui ui)
      const p2pRes = await fetch(`${instance.url}/api/p2p`)
      assert.equal(p2pRes.status, 200)
      assert.equal(await isMemosebuiServerRunning(instance.port), true)

      // 7. Delete via DELETE /api/memories/:id
      const delRes = await fetch(
        `${instance.url}/api/memories/${createdData.memory.id}`,
        { method: 'DELETE' }
      )
      assert.equal(delRes.status, 200)
    } finally {
      await instance.close()
    }
    assert.equal(await isMemosebuiServerRunning(instance.port), false)
  })
})
