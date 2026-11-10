import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  isMindsebRegistered,
  registerMindsebNode,
  unregisterMindsebNode,
} from '../src/cli/setup.ts'
import { startUiServer } from '../src/cli/ui-server.ts'

describe('UI Server & Hubseb Topology Registration', () => {
  it('registers and unregisters mindseb in hubseb topology.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindseb-topo-'))
    const topologyPath = path.join(tmpDir, 'topology.json')

    assert.equal(await isMindsebRegistered({ topologyPath }), false)

    const reg = await registerMindsebNode({ topologyPath })
    assert.equal(reg.success, true)
    assert.equal(reg.node.id, 'mindseb')
    assert.ok(reg.node.provides.includes('ui.mind'))
    assert.ok(reg.node.consumes.includes('memory.vault'))
    assert.equal(await isMindsebRegistered({ topologyPath }), true)

    const unreg = await unregisterMindsebNode({ topologyPath })
    assert.equal(unreg.removed, true)
    assert.equal(await isMindsebRegistered({ topologyPath }), false)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('serves HTML, CSS, REST CRUD endpoints, RRF search and SSE events', async () => {
    const instance = await startUiServer({
      port: 0,
      dbPath: ':memory:',
      disableWatcher: true,
    })

    try {
      // 1. HTML & CSS
      const htmlRes = await fetch(`${instance.url}/`)
      assert.equal(htmlRes.status, 200)
      const html = await htmlRes.text()
      assert.ok(html.includes('mindseb'))

      const cssRes = await fetch(`${instance.url}/styles/mind.css`)
      assert.equal(cssRes.status, 200)

      // 2. Create memory via POST /api/memories
      const createRes = await fetch(`${instance.url}/api/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'mindseb',
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

      // 3. Fetch graph via GET /api/graph
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

      // 6. P2P endpoint
      const p2pRes = await fetch(`${instance.url}/api/p2p`)
      assert.equal(p2pRes.status, 200)

      // 7. Delete via DELETE /api/memories/:id
      const delRes = await fetch(
        `${instance.url}/api/memories/${createdData.memory.id}`,
        { method: 'DELETE' }
      )
      assert.equal(delRes.status, 200)
    } finally {
      await instance.close()
    }
  })
})
