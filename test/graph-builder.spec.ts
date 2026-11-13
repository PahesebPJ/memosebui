import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildMindGraph } from '../src/core/graph-builder.ts'
import { VaultBridge } from '../src/core/vault-bridge.ts'

describe('GraphBuilder', () => {
  it('builds project, category, and memory nodes with semantic similarity edges', () => {
    const bridge = new VaultBridge({ dbPath: ':memory:' })

    const m1 = bridge.createMemory({
      projectId: 'memoseb',
      category: 'architecture',
      title: 'SQLite WAL Vector and FTS5 Engine',
      content: 'Hybrid search combining Float32Array cosine similarity and SQLite FTS5 BM25.',
      tags: ['sqlite', 'vectors', 'fts5'],
      importance: 0.9,
    })

    const m2 = bridge.createMemory({
      projectId: 'memosebui',
      category: 'architecture',
      title: 'SQLite Vector Graph Bridge',
      content: 'Reads Float32Array vectors and SQLite FTS5 tables to render semantic similarity edges.',
      tags: ['sqlite', 'vectors', 'graph'],
      importance: 0.85,
    })

    const snapshot = buildMindGraph(bridge, {
      minSimilarity: 0.25,
      groupByCategory: false,
    })

    assert.equal(snapshot.stats.memoryCount, 2)
    const projectNodes = snapshot.nodes.filter((n) => n.type === 'project')
    const memoryNodes = snapshot.nodes.filter((n) => n.type === 'memory')
    assert.equal(projectNodes.length, 2)
    assert.equal(memoryNodes.length, 2)

    const semanticEdges = snapshot.edges.filter(
      (e) => e.kind === 'semantic-similarity'
    )
    assert.ok(
      semanticEdges.length >= 1,
      'Expected semantic similarity edge between related memories across projects'
    )

    const relatedForM1 = snapshot.relatedByMemoryId[m1.memory.id] ?? []
    assert.ok(relatedForM1.some((r) => r.memoryId === m2.memory.id))

    // Grouped by category mode
    const grouped = buildMindGraph(bridge, {
      minSimilarity: 0.25,
      groupByCategory: true,
    })
    const categoryNodes = grouped.nodes.filter((n) => n.type === 'category')
    assert.ok(categoryNodes.length >= 2)

    bridge.close()
  })

  it('builds 1000+ memory graph quickly and supports maxMemoryNodes truncation', () => {
    const bridge = new VaultBridge({ dbPath: ':memory:' })
    for (let i = 0; i < 600; i++) {
      bridge.createMemory({
        projectId: i % 2 === 0 ? 'proj-a' : 'proj-b',
        category: i % 3 === 0 ? 'architecture' : 'decision',
        title: `Memory Node ${i}`,
        content: `Content about sqlite vectors graph performance optimization item ${i}`,
        tags: ['sqlite', `tag-${i % 15}`],
        importance: 0.5 + (i % 5) * 0.1,
      })
    }

    const t0 = performance.now()
    const full = buildMindGraph(bridge, { minSimilarity: 0.45 })
    const elapsedMs = performance.now() - t0

    assert.equal(full.stats.memoryCount, 600)
    assert.equal(full.truncated, false)
    assert.ok(elapsedMs < 3000, `Expected buildMindGraph(600) < 3000ms, got ${elapsedMs}ms`)

    const sliced = buildMindGraph(bridge, { maxMemoryNodes: 150 })
    assert.equal(sliced.memories.length, 150)
    assert.equal(sliced.truncated, true)
    assert.equal(sliced.totalAvailableMemories, 600)

    // Verify duplicate/mixed-case tags within the same memory do not inflate shared-tag edges
    const dupBridge = new VaultBridge({ dbPath: ':memory:' })
    dupBridge.createMemory({
      projectId: 'p1',
      category: 'domain',
      title: 'Alpha',
      content: 'Unique alpha content one',
      tags: ['SQLite', 'sqlite'],
    })
    dupBridge.createMemory({
      projectId: 'p2',
      category: 'bugfix',
      title: 'Beta',
      content: 'Completely unrelated beta text two',
      tags: ['sqlite'],
    })
    const dupGraph = buildMindGraph(dupBridge, { minSimilarity: 0.9 })
    const sharedTagEdges = dupGraph.edges.filter((e) => e.kind === 'shared-tag')
    assert.equal(sharedTagEdges.length, 0)
    dupBridge.close()

    bridge.close()
  })
})
