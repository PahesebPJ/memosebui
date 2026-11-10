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
      projectId: 'mindseb',
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
})
