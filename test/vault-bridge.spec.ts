import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  cosineSimilarity,
  LocalFeatureHashEmbedder,
  VaultBridge,
} from '../src/core/vault-bridge.ts'

describe('VaultBridge & Embedder', () => {
  it('computes deterministic normalized vectors and cosine similarity', () => {
    const embedder = new LocalFeatureHashEmbedder(128)
    const v1 = embedder.embed('SQLite WAL FTS5 hybrid vector memory vault')
    const v2 = embedder.embed('SQLite WAL FTS5 vector memory search')
    const v3 = embedder.embed('CSS flexbox animations glassmorphism')

    const simClose = cosineSimilarity(v1, v2)
    const simFar = cosineSimilarity(v1, v3)
    assert.ok(simClose > 0.45, `Expected high similarity, got ${simClose}`)
    assert.ok(simClose > simFar, 'Expected related texts to have higher similarity')
  })

  it('performs CRUD operations, hybrid RRF search, and tombstone tracking on SQLite', () => {
    const bridge = new VaultBridge({ dbPath: ':memory:' })

    const created1 = bridge.createMemory({
      projectId: 'memosebui',
      projectName: 'memosebui',
      category: 'architecture',
      title: 'Force-Directed Canvas Engine',
      content: 'Uses Verlet velocity integration and Coulomb repulsion at 60fps.',
      tags: ['canvas', 'physics', 'graph'],
      importance: 0.95,
    })
    assert.equal(created1.created, true)
    assert.equal(created1.memory.projectId, 'memosebui')

    const created2 = bridge.createMemory({
      projectId: 'memosebui',
      projectName: 'memosebui',
      category: 'convention',
      title: 'Conventional Commits and Worktrees',
      content: 'All changes run in isolated git worktrees using conventional commits.',
      tags: ['git', 'worktree'],
      importance: 0.8,
    })
    assert.equal(created2.created, true)

    const stats = bridge.getStats()
    assert.equal(stats.projectCount, 1)
    assert.equal(stats.memoryCount, 2)
    assert.equal(stats.vectorCount, 2)

    // Hybrid search
    const searchRes = bridge.searchMemories('Verlet physics canvas repulsion', {
      projectId: 'memosebui',
    })
    assert.ok(searchRes.memories.length >= 1)
    assert.equal(searchRes.memories[0]!.id, created1.memory.id)
    assert.ok(searchRes.memories[0]!.score > 0)

    // Update memory
    const updated = bridge.updateMemory(created1.memory.id, {
      title: 'Updated Force-Directed Graph Engine',
      importance: 1.0,
    })
    assert.ok(updated)
    assert.equal(updated.title, 'Updated Force-Directed Graph Engine')
    assert.equal(updated.importance, 1.0)

    // Delete memory and verify tombstone
    const fpBefore = bridge.getFingerprint()
    const deleted = bridge.deleteMemory(created2.memory.id)
    assert.equal(deleted, true)
    const fpAfter = bridge.getFingerprint()
    assert.notEqual(fpBefore, fpAfter)
    assert.equal(bridge.getStats().memoryCount, 1)

    bridge.close()
  })

  it('analyzes a repository directory and synthesizes architecture, convention and domain memories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memosebui-analyze-'))
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'sample-app',
        description: 'Sample application for testing repository analysis',
        scripts: { build: 'tsc', test: 'node --test' },
      }),
      'utf8'
    )
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })

    const bridge = new VaultBridge({ dbPath: ':memory:' })
    const report = bridge.analyzeProjectDirectory(tmpDir)

    assert.equal(report.projectId, 'sample-app')
    assert.equal(report.stored.length, 3)
    const categories = new Set(report.stored.map((m) => m.category))
    assert.ok(categories.has('architecture'))
    assert.ok(categories.has('convention'))
    assert.ok(categories.has('domain'))

    bridge.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
