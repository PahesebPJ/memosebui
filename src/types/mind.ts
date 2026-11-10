export type MemoryCategory =
  | 'architecture'
  | 'convention'
  | 'bugfix'
  | 'decision'
  | 'domain'

export type NodeRole = 'standalone' | 'parent' | 'child'
export type PeerRole = 'parent' | 'child'
export type GroupPermissionMode = 'readwrite' | 'readonly' | 'writeonly'
export type UnassignedGroupPolicy = 'none' | 'all'

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'architecture',
  'convention',
  'bugfix',
  'decision',
  'domain',
] as const

export const CATEGORY_COLORS: Record<MemoryCategory, string> = {
  architecture: '#38bdf8',
  convention: '#a855f7',
  bugfix: '#f97316',
  decision: '#10b981',
  domain: '#6366f1',
}

export interface MemoryRecord {
  id: string
  projectId: string
  category: MemoryCategory
  title: string
  content: string
  tags: string[]
  sourceAgent: string | null
  contentHash: string
  tokenCount: number
  importance: number
  accessCount: number
  createdAt: string
  updatedAt: string
}

export interface MemoryWithVector extends MemoryRecord {
  vector: Float32Array | null
}

export interface ScoredMemory extends MemoryRecord {
  score: number
  vectorScore: number
  ftsScore: number
}

export interface ProjectSummary {
  id: string
  name: string
  rootPath: string
  updatedAt: string
  memoryCount: number
  totalTokens: number
}

export interface VaultStats {
  dbPath: string
  projectCount: number
  memoryCount: number
  vectorCount: number
  totalTokens: number
}

export interface NodeConfiguration {
  nodeId: string
  nodeName: string
  enabled: boolean
  role: NodeRole
  listenHost: string
  listenPort: number
  authToken: string | null
  autoSync: boolean
  lanDiscovery: boolean
  unassignedGroupPolicy: UnassignedGroupPolicy
}

export interface SyncPeerRecord {
  id: string
  peerNodeId: string | null
  role: PeerRole
  name: string
  url: string
  lastSyncAt: string | null
  lastStatus: string | null
  updatedAt: string
}

export interface SyncGroupRecord {
  id: string
  name: string
  description: string
  projects: string[]
  categories: string[]
  permissions: GroupPermissionMode
  memberNodeIds: string[]
  createdAt: string
  updatedAt: string
}

export type GraphNodeType =
  | 'project'
  | 'category'
  | 'memory'
  | 'peer'
  | 'group'
  | 'local-node'

export type GraphEdgeKind =
  | 'project-memory'
  | 'project-category'
  | 'category-memory'
  | 'semantic-similarity'
  | 'shared-tag'
  | 'p2p-sync'
  | 'group-acl'

export interface RelatedMemoryLink {
  memoryId: string
  title: string
  projectId: string
  category: MemoryCategory
  similarity: number
  sharedTags: string[]
}

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  subtitle?: string
  projectId?: string
  category?: MemoryCategory
  memoryId?: string
  importance?: number
  tokenCount?: number
  accessCount?: number
  tags?: string[]
  updatedAt?: string
  radius: number
  color: string
  meta?: Record<string, unknown>
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: GraphEdgeKind
  weight: number
  label?: string
}

export interface GraphBuildOptions {
  projectId?: string
  category?: MemoryCategory
  minSimilarity?: number
  includeSharedTags?: boolean
  includeCrossProjectLinks?: boolean
  groupByCategory?: boolean
}

export interface MindGraphSnapshot {
  generatedAt: string
  stats: VaultStats
  projects: ProjectSummary[]
  memories: MemoryRecord[]
  relatedByMemoryId: Record<string, RelatedMemoryLink[]>
  nodes: GraphNode[]
  edges: GraphEdge[]
  p2p: {
    nodeConfig: NodeConfiguration
    peers: SyncPeerRecord[]
    groups: SyncGroupRecord[]
  }
}

export interface CreateMemoryInput {
  projectId?: string
  projectName?: string
  rootPath?: string
  category?: MemoryCategory
  title?: string
  content: string
  tags?: readonly string[]
  sourceAgent?: string
  importance?: number
}

export interface UpdateMemoryInput {
  title?: string
  content?: string
  category?: MemoryCategory
  tags?: readonly string[]
  importance?: number
  projectId?: string
}
