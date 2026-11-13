import {
  CATEGORY_COLORS,
  type GraphBuildOptions,
  type GraphEdge,
  type GraphNode,
  type MemoryRecord,
  type MindGraphSnapshot,
  type RelatedMemoryLink,
} from '../types/mind.ts'
import type { VaultBridge } from './vault-bridge.ts'

const STOP_TAGS = new Set(['overview', 'general', 'default'])

function computeInvNorm(vec: Float32Array | null): number {
  if (!vec || vec.length === 0) return 0
  let sum = 0
  for (let k = 0; k < vec.length; k++) {
    const v = vec[k]!
    sum += v * v
  }
  return sum > 0 ? 1 / Math.sqrt(sum) : 0
}

function fastCosine(
  a: Float32Array,
  b: Float32Array,
  invNormA: number,
  invNormB: number
): number {
  if (invNormA === 0 || invNormB === 0) return 0
  const len = a.length < b.length ? a.length : b.length
  let dot = 0
  for (let k = 0; k < len; k++) {
    dot += a[k]! * b[k]!
  }
  const sim = dot * invNormA * invNormB
  return sim > 0 ? sim : 0
}

function insertTopRelated(
  list: RelatedMemoryLink[],
  item: RelatedMemoryLink,
  maxItems = 8
): void {
  if (list.length < maxItems) {
    list.push(item)
    if (list.length === maxItems) {
      list.sort((x, y) => y.similarity - x.similarity)
    }
    return
  }
  if (item.similarity <= list[maxItems - 1]!.similarity) {
    return
  }
  list[maxItems - 1] = item
  for (let k = maxItems - 1; k > 0; k--) {
    if (list[k]!.similarity > list[k - 1]!.similarity) {
      const tmp = list[k - 1]!
      list[k - 1] = list[k]!
      list[k] = tmp
    } else {
      break
    }
  }
}

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
    limit: options?.maxMemoryNodes,
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

  // Pairwise semantic similarity & shared tags (optimized with precomputed norms & inverted tag index)
  const relatedByMemoryId: Record<string, RelatedMemoryLink[]> = {}
  const pairCount = memoriesWithVectors.length
  const invNorms = new Float64Array(pairCount)
  const tagIndex = new Map<string, number[]>()

  for (let i = 0; i < pairCount; i++) {
    const m = memoriesWithVectors[i]!
    relatedByMemoryId[m.id] = []
    invNorms[i] = computeInvNorm(m.vector)
    for (const rawTag of m.tags) {
      const t = rawTag.toLowerCase()
      if (STOP_TAGS.has(t) || t === m.category || t === m.projectId) continue
      let bucket = tagIndex.get(t)
      if (!bucket) {
        bucket = []
        tagIndex.set(t, bucket)
      }
      bucket.push(i)
    }
  }

  // Build shared-tag map in O(sum(bucket^2)) for non-stop tags (skip huge tags > 200 entries)
  const sharedTagsByPair = new Map<number, string[]>()
  for (const [tag, indices] of tagIndex.entries()) {
    if (indices.length < 2 || indices.length > 200) continue
    for (let aIdx = 0; aIdx < indices.length; aIdx++) {
      const i = indices[aIdx]!
      for (let bIdx = aIdx + 1; bIdx < indices.length; bIdx++) {
        const j = indices[bIdx]!
        const key = i * pairCount + j
        let arr = sharedTagsByPair.get(key)
        if (!arr) {
          arr = []
          sharedTagsByPair.set(key, arr)
        }
        arr.push(tag)
      }
    }
  }

  const semanticCandidates: Array<{
    a: (typeof memoriesWithVectors)[number]
    b: (typeof memoriesWithVectors)[number]
    similarity: number
    sharedTags: string[]
  }> = []

  const relatedThreshold = 0.22
  for (let i = 0; i < pairCount; i++) {
    const a = memoriesWithVectors[i]!
    const vecA = a.vector
    const invA = invNorms[i]!
    const rowBase = i * pairCount

    for (let j = i + 1; j < pairCount; j++) {
      const b = memoriesWithVectors[j]!
      if (!includeCrossProjectLinks && a.projectId !== b.projectId) {
        continue
      }

      const rawSim =
        vecA && b.vector ? fastCosine(vecA, b.vector, invA, invNorms[j]!) : 0
      const sharedTags = sharedTagsByPair.get(rowBase + j) ?? []

      if (rawSim >= relatedThreshold || sharedTags.length > 0) {
        const similarity = Math.round(rawSim * 10000) / 10000
        insertTopRelated(relatedByMemoryId[a.id]!, {
          memoryId: b.id,
          title: b.title,
          projectId: b.projectId,
          category: b.category,
          similarity,
          sharedTags,
        })
        insertTopRelated(relatedByMemoryId[b.id]!, {
          memoryId: a.id,
          title: a.title,
          projectId: a.projectId,
          category: a.category,
          similarity,
          sharedTags,
        })

        if (
          similarity >= minSimilarity ||
          (includeSharedTags && sharedTags.length >= 2)
        ) {
          semanticCandidates.push({ a, b, similarity, sharedTags })
        }
      }
    }
  }

  // Ensure remaining (<8) related lists are sorted descending
  for (const id of Object.keys(relatedByMemoryId)) {
    const list = relatedByMemoryId[id]!
    if (list.length > 1 && list.length < 8) {
      list.sort((x, y) => y.similarity - x.similarity)
    }
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

  const truncated = Boolean(
    options?.maxMemoryNodes &&
      options.maxMemoryNodes > 0 &&
      memories.length < stats.memoryCount &&
      (!options.projectId || options.projectId === 'all') &&
      !options.category
  )

  return {
    generatedAt: new Date().toISOString(),
    stats,
    projects: allProjects,
    memories,
    relatedByMemoryId,
    nodes,
    edges,
    truncated,
    totalAvailableMemories: stats.memoryCount,
    p2p: {
      nodeConfig: bridge.getNodeConfig(),
      peers: bridge.listPeers(),
      groups: bridge.listGroups(),
    },
  }
}
