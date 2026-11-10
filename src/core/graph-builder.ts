import {
  CATEGORY_COLORS,
  type GraphBuildOptions,
  type GraphEdge,
  type GraphNode,
  type MemoryRecord,
  type MindGraphSnapshot,
  type RelatedMemoryLink,
} from '../types/mind.ts'
import { cosineSimilarity, type VaultBridge } from './vault-bridge.ts'

const STOP_TAGS = new Set(['overview', 'general', 'default'])

export function buildMindGraph(
  bridge: VaultBridge,
  options?: GraphBuildOptions
): MindGraphSnapshot {
  const minSimilarity = Math.min(
    0.98,
    Math.max(0.15, options?.minSimilarity ?? 0.38)
  )
  const includeSharedTags = options?.includeSharedTags !== false
  const includeCrossProjectLinks = options?.includeCrossProjectLinks !== false
  const groupByCategory = Boolean(options?.groupByCategory)

  const stats = bridge.getStats()
  const allProjects = bridge.listProjects()
  const memoriesWithVectors = bridge.listMemoriesWithVectors({
    projectId: options?.projectId,
    category: options?.category,
  })

  const activeProjectIds = new Set<string>(
    memoriesWithVectors.map((m) => m.projectId)
  )
  if (options?.projectId && options.projectId !== 'all') {
    activeProjectIds.add(options.projectId)
  }

  const projects =
    options?.projectId && options.projectId !== 'all'
      ? allProjects.filter((p) => p.id === options.projectId)
      : allProjects.filter(
          (p) => p.memoryCount > 0 || activeProjectIds.has(p.id)
        )

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const projectNodeIds = new Set<string>()
  const categoryNodeIds = new Set<string>()

  for (const proj of projects) {
    const nodeId = `project:${proj.id}`
    projectNodeIds.add(proj.id)
    const radius = Math.min(
      34,
      Math.max(20, 18 + Math.sqrt(proj.memoryCount) * 3.2)
    )
    nodes.push({
      id: nodeId,
      type: 'project',
      label: proj.name,
      subtitle: `${proj.memoryCount} recuerdos · ${proj.totalTokens} tokens`,
      projectId: proj.id,
      tokenCount: proj.totalTokens,
      updatedAt: proj.updatedAt,
      radius: Number(radius.toFixed(1)),
      color: proj.id === 'global' ? '#f43f5e' : '#f59e0b',
      meta: {
        rootPath: proj.rootPath,
        memoryCount: proj.memoryCount,
      },
    })
  }

  // Ensure every memory's project has a project node
  for (const mem of memoriesWithVectors) {
    if (!projectNodeIds.has(mem.projectId)) {
      projectNodeIds.add(mem.projectId)
      nodes.push({
        id: `project:${mem.projectId}`,
        type: 'project',
        label: mem.projectId,
        subtitle: 'Proyecto indexado',
        projectId: mem.projectId,
        radius: 22,
        color: mem.projectId === 'global' ? '#f43f5e' : '#f59e0b',
      })
    }

    if (groupByCategory) {
      const catNodeId = `category:${mem.projectId}:${mem.category}`
      if (!categoryNodeIds.has(catNodeId)) {
        categoryNodeIds.add(catNodeId)
        nodes.push({
          id: catNodeId,
          type: 'category',
          label: mem.category,
          subtitle: `${mem.projectId} · ${mem.category}`,
          projectId: mem.projectId,
          category: mem.category,
          radius: 14,
          color: CATEGORY_COLORS[mem.category] ?? '#38bdf8',
        })
        edges.push({
          id: `edge:proj-cat:${mem.projectId}:${mem.category}`,
          source: `project:${mem.projectId}`,
          target: catNodeId,
          kind: 'project-category',
          weight: 0.9,
        })
      }
    }

    const memNodeId = `memory:${mem.id}`
    const importanceBoost = (mem.importance ?? 0.5) * 6.5
    const accessBoost = Math.min(4, Math.log2((mem.accessCount ?? 0) + 1) * 1.4)
    const radius = Number((8.5 + importanceBoost + accessBoost).toFixed(1))

    nodes.push({
      id: memNodeId,
      type: 'memory',
      label: mem.title,
      subtitle: `${mem.projectId} · ${mem.category}`,
      projectId: mem.projectId,
      category: mem.category,
      memoryId: mem.id,
      importance: mem.importance,
      tokenCount: mem.tokenCount,
      accessCount: mem.accessCount,
      tags: mem.tags,
      updatedAt: mem.updatedAt,
      radius,
      color: CATEGORY_COLORS[mem.category] ?? '#6366f1',
    })

    if (groupByCategory) {
      edges.push({
        id: `edge:cat-mem:${mem.projectId}:${mem.category}:${mem.id}`,
        source: `category:${mem.projectId}:${mem.category}`,
        target: memNodeId,
        kind: 'category-memory',
        weight: 0.85,
      })
    } else {
      edges.push({
        id: `edge:proj-mem:${mem.projectId}:${mem.id}`,
        source: `project:${mem.projectId}`,
        target: memNodeId,
        kind: 'project-memory',
        weight: 0.85,
      })
    }
  }

  // Pairwise semantic similarity & shared tags
  const relatedByMemoryId: Record<string, RelatedMemoryLink[]> = {}
  for (const mem of memoriesWithVectors) {
    relatedByMemoryId[mem.id] = []
  }

  const pairCount = memoriesWithVectors.length
  const semanticCandidates: Array<{
    a: (typeof memoriesWithVectors)[number]
    b: (typeof memoriesWithVectors)[number]
    similarity: number
    sharedTags: string[]
  }> = []

  for (let i = 0; i < pairCount; i++) {
    const a = memoriesWithVectors[i]!
    const tagsA = new Set(
      a.tags
        .map((t) => t.toLowerCase())
        .filter((t) => !STOP_TAGS.has(t) && t !== a.category && t !== a.projectId)
    )

    for (let j = i + 1; j < pairCount; j++) {
      const b = memoriesWithVectors[j]!
      if (!includeCrossProjectLinks && a.projectId !== b.projectId) {
        continue
      }

      const similarity =
        a.vector && b.vector
          ? Number(Math.max(0, cosineSimilarity(a.vector, b.vector)).toFixed(4))
          : 0

      const sharedTags: string[] = []
      if (tagsA.size > 0) {
        for (const t of b.tags) {
          const lower = t.toLowerCase()
          if (tagsA.has(lower)) {
            sharedTags.push(lower)
          }
        }
      }

      if (similarity >= 0.22 || sharedTags.length > 0) {
        relatedByMemoryId[a.id]!.push({
          memoryId: b.id,
          title: b.title,
          projectId: b.projectId,
          category: b.category,
          similarity,
          sharedTags,
        })
        relatedByMemoryId[b.id]!.push({
          memoryId: a.id,
          title: a.title,
          projectId: a.projectId,
          category: a.category,
          similarity,
          sharedTags,
        })
      }

      if (similarity >= minSimilarity || (includeSharedTags && sharedTags.length >= 2)) {
        semanticCandidates.push({ a, b, similarity, sharedTags })
      }
    }
  }

  // Sort related memories per memory by similarity descending
  for (const id of Object.keys(relatedByMemoryId)) {
    relatedByMemoryId[id]!.sort((x, y) => y.similarity - x.similarity)
    relatedByMemoryId[id] = relatedByMemoryId[id]!.slice(0, 8)
  }

  // Cap semantic edges per node so the force layout stays clean and legible
  semanticCandidates.sort((x, y) => y.similarity - x.similarity)
  const degreeByMemId = new Map<string, number>()
  const maxSemanticDegreePerNode = 4

  for (const cand of semanticCandidates) {
    const degA = degreeByMemId.get(cand.a.id) ?? 0
    const degB = degreeByMemId.get(cand.b.id) ?? 0
    if (degA >= maxSemanticDegreePerNode || degB >= maxSemanticDegreePerNode) {
      continue
    }

    if (cand.similarity >= minSimilarity) {
      edges.push({
        id: `edge:sem:${cand.a.id}:${cand.b.id}`,
        source: `memory:${cand.a.id}`,
        target: `memory:${cand.b.id}`,
        kind: 'semantic-similarity',
        weight: cand.similarity,
        label: `${Math.round(cand.similarity * 100)}%`,
      })
      degreeByMemId.set(cand.a.id, degA + 1)
      degreeByMemId.set(cand.b.id, degB + 1)
    } else if (includeSharedTags && cand.sharedTags.length >= 2) {
      edges.push({
        id: `edge:tag:${cand.a.id}:${cand.b.id}`,
        source: `memory:${cand.a.id}`,
        target: `memory:${cand.b.id}`,
        kind: 'shared-tag',
        weight: 0.35,
        label: `#${cand.sharedTags[0]}`,
      })
      degreeByMemId.set(cand.a.id, degA + 1)
      degreeByMemId.set(cand.b.id, degB + 1)
    }
  }

  const memories: MemoryRecord[] = memoriesWithVectors.map(
    ({ vector: _vector, ...rec }) => rec
  )

  return {
    generatedAt: new Date().toISOString(),
    stats,
    projects: allProjects,
    memories,
    relatedByMemoryId,
    nodes,
    edges,
    p2p: {
      nodeConfig: bridge.getNodeConfig(),
      peers: bridge.listPeers(),
      groups: bridge.listGroups(),
    },
  }
}
