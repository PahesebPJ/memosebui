import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type CreateMemoryInput,
  type GroupPermissionMode,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryRecord,
  type MemoryWithVector,
  type NodeConfiguration,
  type NodeRole,
  type ProjectSummary,
  type ScoredMemory,
  type SyncGroupRecord,
  type SyncPeerRecord,
  type UnassignedGroupPolicy,
  type UpdateMemoryInput,
  type VaultStats,
} from '../types/mind.ts'

export const DEFAULT_DIMENSIONS = 384

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_agent TEXT,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 1,
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(project_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_id, content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  project_id UNINDEXED,
  title,
  content,
  tags
);

CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  memory_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  origin_node_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_tombstones_updated ON memory_tombstones(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tombstones_project_hash ON memory_tombstones(project_id, content_hash);

CREATE TABLE IF NOT EXISTS node_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_peers (
  id TEXT PRIMARY KEY,
  peer_node_id TEXT,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  auth_token TEXT,
  last_sync_at TEXT,
  last_status TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_peers_role ON sync_peers(role);

CREATE TABLE IF NOT EXISTS sync_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  projects TEXT NOT NULL DEFAULT '["*"]',
  categories TEXT NOT NULL DEFAULT '["*"]',
  permissions TEXT NOT NULL DEFAULT 'readwrite',
  group_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_group_members (
  group_id TEXT NOT NULL,
  peer_identifier TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, peer_identifier),
  FOREIGN KEY (group_id) REFERENCES sync_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_group_members_peer ON sync_group_members(peer_identifier);
`

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value)
}

export function slugifyProjectId(raw: string): string {
  const withoutScope = raw.trim().replace(/^@[^/]+\//, '')
  const slug = withoutScope
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default-project'
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    const va = a[i]!
    const vb = b[i]!
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

export function serializeVector(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function deserializeVector(blob: Uint8Array): Float32Array {
  const usableLength = blob.byteLength - (blob.byteLength % 4)
  const copy = new Uint8Array(usableLength)
  copy.set(blob.subarray(0, usableLength))
  return new Float32Array(copy.buffer)
}

function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export class LocalFeatureHashEmbedder {
  readonly model = 'local-feature-hash-v1'
  readonly dimensions: number

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    this.dimensions = dimensions
  }

  embed(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions)
    const normalized = text.toLowerCase().normalize('NFKD')
    const words = normalized.match(/[a-z0-9]+/g) ?? []
    if (words.length === 0) return vec

    const addFeature = (feature: string, weight: number): void => {
      const h1 = fnv1a32(feature, 0x811c9dc5)
      const h2 = fnv1a32(feature, 0x9e3779b9)
      const index = h1 % this.dimensions
      const sign = (h2 & 1) === 0 ? 1 : -1
      vec[index] = vec[index]! + sign * weight
    }

    for (let i = 0; i < words.length; i++) {
      const word = words[i]!
      addFeature(`w:${word}`, 2.0)
      if (word.length >= 4) addFeature(`p4:${word.slice(0, 4)}`, 1.0)
      if (word.length >= 5) addFeature(`p5:${word.slice(0, 5)}`, 1.0)
      if (i + 1 < words.length) {
        addFeature(`b:${word}_${words[i + 1]!}`, 1.5)
      }
      const padded = `^${word}$`
      for (let j = 0; j <= padded.length - 3; j++) {
        addFeature(`c3:${padded.slice(j, j + 3)}`, 0.75)
      }
    }

    let normSq = 0
    for (let i = 0; i < this.dimensions; i++) {
      const v = vec[i]!
      normSq += v * v
    }
    if (normSq > 0) {
      const invNorm = 1 / Math.sqrt(normSq)
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] = vec[i]! * invNorm
      }
    }
    return vec
  }
}

export function getDefaultVaultDbPath(): string {
  if (process.env.MEMOSEB_DB_PATH && process.env.MEMOSEB_DB_PATH.trim().length > 0) {
    return path.resolve(process.env.MEMOSEB_DB_PATH.trim())
  }
  const xdgData = process.env.XDG_DATA_HOME?.trim()
  const baseDir =
    xdgData && xdgData.length > 0
      ? xdgData
      : process.platform === 'win32'
        ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        : process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support')
          : path.join(os.homedir(), '.local', 'share')
  return path.join(baseDir, 'memoseb', 'vault.sqlite')
}

interface RawMemoryRow {
  id: string
  project_id: string
  category: string
  title: string
  content: string
  tags: string
  source_agent: string | null
  content_hash: string
  token_count: number
  importance: number
  access_count: number
  created_at: string
  updated_at: string
  vector_blob?: Uint8Array | null
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    }
  } catch {
    // ignore malformed json
  }
  return []
}

function mapRowToMemoryRecord(row: RawMemoryRow): MemoryRecord {
  const category: MemoryCategory = isMemoryCategory(row.category)
    ? row.category
    : 'domain'
  return {
    id: row.id,
    projectId: row.project_id,
    category,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    sourceAgent: row.source_agent ?? null,
    contentHash: row.content_hash,
    tokenCount: Number(row.token_count),
    importance: Number(row.importance),
    accessCount: Number(row.access_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.filter((token) => token.length > 0)
  if (!tokens || tokens.length === 0) return ''
  const unique = Array.from(new Set(tokens))
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

function clampImportance(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

function deriveDefaultTitle(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0]?.trim() ?? 'Memory'
  if (firstLine.length <= 72) return firstLine
  return `${firstLine.slice(0, 69)}...`
}

export class VaultBridge {
  readonly dbPath: string
  private readonly db: DatabaseSync
  private readonly embedder: LocalFeatureHashEmbedder

  constructor(options?: { dbPath?: string; dimensions?: number }) {
    this.dbPath = options?.dbPath ?? getDefaultVaultDbPath()
    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    }
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA_SQL)
    this.embedder = new LocalFeatureHashEmbedder(options?.dimensions ?? DEFAULT_DIMENSIONS)
  }

  getStats(): VaultStats {
    const projectRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM projects`)
      .get() as { cnt: number }
    const memoryRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(token_count), 0) AS tokens FROM memories`
      )
      .get() as { cnt: number; tokens: number }
    const vectorRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM memory_vectors`)
      .get() as { cnt: number }

    return {
      dbPath: this.dbPath,
      projectCount: Number(projectRow.cnt),
      memoryCount: Number(memoryRow.cnt),
      vectorCount: Number(vectorRow.cnt),
      totalTokens: Number(memoryRow.tokens),
    }
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
           p.id,
           p.name,
           p.root_path,
           p.updated_at,
           COUNT(m.id) AS memory_count,
           COALESCE(SUM(m.token_count), 0) AS total_tokens
         FROM projects p
         LEFT JOIN memories m ON m.project_id = p.id
         GROUP BY p.id
         ORDER BY memory_count DESC, p.updated_at DESC`
      )
      .all() as Array<{
      id: string
      name: string
      root_path: string
      updated_at: string
      memory_count: number
      total_tokens: number
    }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      updatedAt: row.updated_at,
      memoryCount: Number(row.memory_count),
      totalTokens: Number(row.total_tokens),
    }))
  }

  listMemoriesWithVectors(filter?: {
    projectId?: string
    category?: MemoryCategory
  }): MemoryWithVector[] {
    const clauses: string[] = []
    const params: string[] = []

    if (filter?.projectId && filter.projectId !== 'all') {
      clauses.push('m.project_id = ?')
      params.push(slugifyProjectId(filter.projectId))
    }
    if (filter?.category && isMemoryCategory(filter.category)) {
      clauses.push('m.category = ?')
      params.push(filter.category)
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT m.*, mv.embedding AS vector_blob
         FROM memories m
         LEFT JOIN memory_vectors mv ON mv.memory_id = m.id
         ${whereSql}
         ORDER BY m.importance DESC, m.updated_at DESC`
      )
      .all(...params) as unknown as RawMemoryRow[]

    return rows.map((row) => {
      const record = mapRowToMemoryRecord(row)
      let vector: Float32Array | null = null
      if (row.vector_blob && row.vector_blob.byteLength > 0) {
        vector = deserializeVector(row.vector_blob)
      } else {
        vector = this.embedder.embed(
          `${record.title}\n${record.content}\n${record.tags.join(' ')}`
        )
      }
      return {
        ...record,
        vector,
      }
    })
  }

  getMemoryById(id: string): MemoryRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM memories WHERE id = ? LIMIT 1`)
      .get(id) as unknown as RawMemoryRow | undefined
    if (!row) return null
    return mapRowToMemoryRecord(row)
  }

  searchMemories(
    query: string,
    options?: {
      projectId?: string
      category?: MemoryCategory
      limit?: number
      maxTokens?: number
    }
  ): {
    memories: ScoredMemory[]
    totalTokens: number
    truncatedByBudget: boolean
  } {
    const trimmedQuery = query.trim()
    const limit = Math.max(1, options?.limit ?? 20)
    const maxTokens = Math.max(50, options?.maxTokens ?? 4000)

    const candidates = this.listMemoriesWithVectors({
      projectId: options?.projectId,
      category: options?.category,
    })

    if (candidates.length === 0 || trimmedQuery.length === 0) {
      const top = candidates.slice(0, limit).map((c) => ({
        ...c,
        score: Number(c.importance.toFixed(4)),
        vectorScore: 0,
        ftsScore: 0,
      }))
      return {
        memories: top,
        totalTokens: top.reduce((acc, m) => acc + m.tokenCount, 0),
        truncatedByBudget: false,
      }
    }

    const candidatesById = new Map<string, MemoryWithVector>()
    for (const c of candidates) {
      candidatesById.set(c.id, c)
    }

    const ftsRankById = new Map<string, { rank: number; rawScore: number }>()
    const ftsQuery = sanitizeFtsQuery(trimmedQuery)
    if (ftsQuery.length > 0) {
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT memory_id, bm25(memories_fts, 2.0, 1.0, 1.5) AS bm25_score
             FROM memories_fts
             WHERE memories_fts MATCH ?
             ORDER BY bm25_score ASC`
          )
          .all(ftsQuery) as Array<{ memory_id: string; bm25_score: number }>

        let rankIndex = 1
        for (const ftsRow of ftsRows) {
          if (!candidatesById.has(ftsRow.memory_id)) continue
          const positiveLexical = Math.max(0, -Number(ftsRow.bm25_score))
          ftsRankById.set(ftsRow.memory_id, {
            rank: rankIndex,
            rawScore: positiveLexical,
          })
          rankIndex++
        }
      } catch {
        // fallback to vector similarity
      }
    }

    const queryVec = this.embedder.embed(trimmedQuery)
    const vectorScored: Array<{ id: string; similarity: number }> = []
    for (const [id, entry] of candidatesById.entries()) {
      const similarity = entry.vector
        ? Math.max(0, cosineSimilarity(queryVec, entry.vector))
        : 0
      vectorScored.push({ id, similarity })
    }
    vectorScored.sort((a, b) => b.similarity - a.similarity)

    const vecRankById = new Map<string, { rank: number; similarity: number }>()
    vectorScored.forEach((item, idx) => {
      vecRankById.set(item.id, { rank: idx + 1, similarity: item.similarity })
    })

    const rrfK = 10
    const scoredCandidates: ScoredMemory[] = []
    for (const [id, entry] of candidatesById.entries()) {
      const vecInfo = vecRankById.get(id)
      const ftsInfo = ftsRankById.get(id)
      const vectorScore = vecInfo?.similarity ?? 0
      const ftsScore = ftsInfo?.rawScore ?? 0

      if (vectorScore <= 0.05 && !ftsInfo) continue

      const vecRrf =
        vecInfo && vecInfo.similarity > 0 ? 1.0 / (rrfK + vecInfo.rank) : 0
      const ftsRrf = ftsInfo ? 1.2 / (rrfK + ftsInfo.rank) : 0
      const rrfScore =
        vecRrf + ftsRrf + 0.25 * vectorScore + 0.1 * entry.importance

      const { vector: _vec, ...record } = entry
      scoredCandidates.push({
        ...record,
        score: Number(rrfScore.toFixed(6)),
        vectorScore: Number(vectorScore.toFixed(6)),
        ftsScore: Number(ftsScore.toFixed(6)),
      })
    }

    scoredCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.updatedAt.localeCompare(a.updatedAt)
    })

    const topLimited = scoredCandidates.slice(0, limit)
    const selected: ScoredMemory[] = []
    let totalTokens = 0
    let truncatedByBudget = false

    for (const candidate of topLimited) {
      const cost = Math.max(1, candidate.tokenCount)
      if (totalTokens + cost > maxTokens) {
        truncatedByBudget = true
        continue
      }
      selected.push(candidate)
      totalTokens += cost
    }

    return {
      memories: selected,
      totalTokens,
      truncatedByBudget,
    }
  }

  createMemory(input: CreateMemoryInput): {
    memory: MemoryRecord
    created: boolean
  } {
    const trimmedContent = input.content.trim()
    if (trimmedContent.length === 0) {
      throw new Error('Memory content must not be empty.')
    }

    const projectId = slugifyProjectId(input.projectId || 'global')
    const projectName = input.projectName?.trim() || projectId
    const rootPath =
      input.rootPath?.trim() ||
      (projectId === 'global' ? 'global' : process.cwd())

    const category: MemoryCategory =
      input.category && isMemoryCategory(input.category)
        ? input.category
        : 'domain'
    const title =
      input.title && input.title.trim().length > 0
        ? input.title.trim()
        : deriveDefaultTitle(trimmedContent)
    const tags = Array.from(
      new Set(
        (input.tags ?? [])
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      )
    )
    const tagsJson = JSON.stringify(tags)
    const tagsText = tags.join(' ')
    const sourceAgent = input.sourceAgent?.trim() || 'mindseb-ui'
    const importance = clampImportance(input.importance)
    const now = new Date().toISOString()

    const contentHash = crypto
      .createHash('sha256')
      .update(`${projectId}:${category}:${trimmedContent}`)
      .digest('hex')

    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at`
      )
      .run(projectId, projectName, rootPath, now)

    const existing = this.db
      .prepare(
        `SELECT * FROM memories WHERE project_id = ? AND content_hash = ? LIMIT 1`
      )
      .get(projectId, contentHash) as unknown as RawMemoryRow | undefined

    const embeddingText = `${title}\n${trimmedContent}\n${tagsText}`
    const vector = this.embedder.embed(embeddingText)
    const serializedVector = serializeVector(vector)
    const tokenCount = estimateTokens(`${title}\n${trimmedContent}`)

    if (existing) {
      this.db
        .prepare(
          `DELETE FROM memory_tombstones
           WHERE (project_id = ? AND content_hash = ?) OR memory_id = ?`
        )
        .run(projectId, contentHash, existing.id)

      this.db
        .prepare(
          `UPDATE memories
           SET title = ?,
               tags = ?,
               source_agent = ?,
               importance = ?,
               token_count = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          title,
          tagsJson,
          sourceAgent,
          importance,
          tokenCount,
          now,
          existing.id
        )

      this.db
        .prepare(`DELETE FROM memories_fts WHERE memory_id = ?`)
        .run(existing.id)
      this.db
        .prepare(
          `INSERT INTO memories_fts (memory_id, project_id, title, content, tags)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(existing.id, projectId, title, trimmedContent, tagsText)

      this.db
        .prepare(
          `INSERT INTO memory_vectors (memory_id, dimensions, embedding, model)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             dimensions = excluded.dimensions,
             embedding = excluded.embedding,
             model = excluded.model`
        )
        .run(
          existing.id,
          this.embedder.dimensions,
          serializedVector,
          this.embedder.model
        )

      const updatedRow = this.db
        .prepare(`SELECT * FROM memories WHERE id = ?`)
        .get(existing.id) as unknown as RawMemoryRow

      return {
        memory: mapRowToMemoryRecord(updatedRow),
        created: false,
      }
    }

    const id = crypto.randomUUID()
    this.db
      .prepare(
        `DELETE FROM memory_tombstones
         WHERE (project_id = ? AND content_hash = ?) OR memory_id = ?`
      )
      .run(projectId, contentHash, id)

    this.db
      .prepare(
        `INSERT INTO memories (
           id, project_id, category, title, content, tags, source_agent,
           content_hash, token_count, importance, access_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        projectId,
        category,
        title,
        trimmedContent,
        tagsJson,
        sourceAgent,
        contentHash,
        tokenCount,
        importance,
        now,
        now
      )

    this.db
      .prepare(
        `INSERT INTO memories_fts (memory_id, project_id, title, content, tags)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, projectId, title, trimmedContent, tagsText)

    this.db
      .prepare(
        `INSERT INTO memory_vectors (memory_id, dimensions, embedding, model)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, this.embedder.dimensions, serializedVector, this.embedder.model)

    const insertedRow = this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(id) as unknown as RawMemoryRow

    return {
      memory: mapRowToMemoryRecord(insertedRow),
      created: true,
    }
  }

  updateMemory(id: string, patch: UpdateMemoryInput): MemoryRecord | null {
    const existing = this.getMemoryById(id)
    if (!existing) return null

    const nextTitle =
      patch.title !== undefined && patch.title.trim().length > 0
        ? patch.title.trim()
        : existing.title
    const nextContent =
      patch.content !== undefined && patch.content.trim().length > 0
        ? patch.content.trim()
        : existing.content
    const nextCategory: MemoryCategory =
      patch.category && isMemoryCategory(patch.category)
        ? patch.category
        : existing.category
    const nextProjectId =
      patch.projectId && patch.projectId.trim().length > 0
        ? slugifyProjectId(patch.projectId)
        : existing.projectId
    const nextTags =
      patch.tags !== undefined
        ? Array.from(
            new Set(
              patch.tags
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
            )
          )
        : existing.tags
    const nextImportance =
      patch.importance !== undefined
        ? clampImportance(patch.importance)
        : existing.importance

    const now = new Date().toISOString()
    const contentHash = crypto
      .createHash('sha256')
      .update(`${nextProjectId}:${nextCategory}:${nextContent}`)
      .digest('hex')
    const tagsJson = JSON.stringify(nextTags)
    const tagsText = nextTags.join(' ')
    const tokenCount = estimateTokens(`${nextTitle}\n${nextContent}`)

    const embeddingText = `${nextTitle}\n${nextContent}\n${tagsText}`
    const vector = this.embedder.embed(embeddingText)
    const serializedVector = serializeVector(vector)

    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(nextProjectId, nextProjectId, nextProjectId, now)

    this.db
      .prepare(
        `UPDATE memories
         SET project_id = ?,
             category = ?,
             title = ?,
             content = ?,
             tags = ?,
             content_hash = ?,
             token_count = ?,
             importance = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextProjectId,
        nextCategory,
        nextTitle,
        nextContent,
        tagsJson,
        contentHash,
        tokenCount,
        nextImportance,
        now,
        id
      )

    this.db.prepare(`DELETE FROM memories_fts WHERE memory_id = ?`).run(id)
    this.db
      .prepare(
        `INSERT INTO memories_fts (memory_id, project_id, title, content, tags)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, nextProjectId, nextTitle, nextContent, tagsText)

    this.db
      .prepare(
        `INSERT INTO memory_vectors (memory_id, dimensions, embedding, model)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           dimensions = excluded.dimensions,
           embedding = excluded.embedding,
           model = excluded.model`
      )
      .run(id, this.embedder.dimensions, serializedVector, this.embedder.model)

    return this.getMemoryById(id)
  }

  deleteMemory(id: string): boolean {
    const existing = this.db
      .prepare(`SELECT id, project_id, content_hash FROM memories WHERE id = ?`)
      .get(id) as
      | { id: string; project_id: string; content_hash: string }
      | undefined
    if (!existing) return false

    const now = new Date().toISOString()
    const nodeId = this.getNodeId()

    this.db.prepare(`DELETE FROM memories_fts WHERE memory_id = ?`).run(id)
    this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(id)
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)

    this.db
      .prepare(
        `INSERT INTO memory_tombstones (
           memory_id, project_id, content_hash, deleted_at, origin_node_id
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           project_id = excluded.project_id,
           content_hash = excluded.content_hash,
           deleted_at = excluded.deleted_at,
           origin_node_id = excluded.origin_node_id`
      )
      .run(existing.id, existing.project_id, existing.content_hash, now, nodeId)

    return true
  }

  analyzeProjectDirectory(targetDir: string): {
    projectId: string
    projectName: string
    rootPath: string
    stored: MemoryRecord[]
  } {
    const resolvedRoot = path.resolve(targetDir)
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error(`Project directory does not exist: ${resolvedRoot}`)
    }

    let pkg: Record<string, unknown> | null = null
    const pkgPath = path.join(resolvedRoot, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<
          string,
          unknown
        >
      } catch {
        pkg = null
      }
    }

    const rawName =
      typeof pkg?.name === 'string' && pkg.name.trim().length > 0
        ? pkg.name.trim()
        : path.basename(resolvedRoot)
    const projectId = slugifyProjectId(rawName)
    const projectName = rawName.replace(/^@[^/]+\//, '')

    const manifests = [
      'package.json',
      'tsconfig.json',
      'Cargo.toml',
      'pyproject.toml',
      'go.mod',
      'Dockerfile',
    ].filter((f) => fs.existsSync(path.join(resolvedRoot, f)))

    const topDirs = fs
      .readdirSync(resolvedRoot, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith('.') &&
          d.name !== 'node_modules' &&
          d.name !== 'dist' &&
          d.name !== 'target'
      )
      .map((d) => d.name)
      .sort()

    const archContent = [
      `Proyecto: ${projectName} (${projectId}).`,
      manifests.length > 0
        ? `Manifiestos detectados: ${manifests.join(', ')}.`
        : '',
      topDirs.length > 0 ? `Directorios raíz: ${topDirs.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ')

    const scriptsObj =
      pkg?.scripts && typeof pkg.scripts === 'object'
        ? (pkg.scripts as Record<string, string>)
        : {}
    const scriptEntries = Object.entries(scriptsObj)
      .slice(0, 8)
      .map(([k, v]) => `${k}: "${v}"`)
    const convContent =
      scriptEntries.length > 0
        ? `Scripts npm: ${scriptEntries.join('; ')}.`
        : `Repositorio ${projectName} ubicado en ${resolvedRoot}.`

    const desc =
      typeof pkg?.description === 'string' && pkg.description.trim().length > 0
        ? pkg.description.trim()
        : `Dominio funcional del proyecto ${projectName} (${projectId}).`

    const drafts: Array<{
      category: MemoryCategory
      title: string
      content: string
      tags: string[]
      importance: number
    }> = [
      {
        category: 'architecture',
        title: `Arquitectura y topología de ${projectName}`,
        content: archContent,
        tags: ['architecture', 'topology', projectId],
        importance: 0.9,
      },
      {
        category: 'convention',
        title: `Convenciones, scripts y verificación de ${projectName}`,
        content: convContent,
        tags: ['convention', 'scripts', 'verification'],
        importance: 0.85,
      },
      {
        category: 'domain',
        title: `Propósito funcional y dominio de ${projectName}`,
        content: `Descripción: ${desc}`,
        tags: ['domain', 'overview', projectId],
        importance: 0.8,
      },
    ]

    const stored: MemoryRecord[] = []
    for (const draft of drafts) {
      const res = this.createMemory({
        projectId,
        projectName,
        rootPath: resolvedRoot,
        category: draft.category,
        title: draft.title,
        content: draft.content,
        tags: draft.tags,
        importance: draft.importance,
        sourceAgent: 'mindseb-analyzer',
      })
      stored.push(res.memory)
    }

    return {
      projectId,
      projectName,
      rootPath: resolvedRoot,
      stored,
    }
  }

  getNodeId(): string {
    const row = this.db
      .prepare(`SELECT value FROM node_meta WHERE key = 'node.id'`)
      .get() as { value: string } | undefined
    if (row && row.value.trim().length > 0) {
      return row.value.trim()
    }
    const newId = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO node_meta (key, value, updated_at)
         VALUES ('node.id', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(newId, now)
    return newId
  }

  getNodeConfig(): NodeConfiguration {
    const rows = this.db
      .prepare(`SELECT key, value FROM node_meta`)
      .all() as Array<{ key: string; value: string }>
    const meta = new Map<string, string>()
    for (const r of rows) {
      meta.set(r.key, r.value)
    }

    const nodeId = this.getNodeId()
    const rawName = meta.get('node.name')?.trim()
    const nodeName = rawName && rawName.length > 0 ? rawName : os.hostname()
    const enabled = meta.get('node.enabled') === 'true'
    const rawRole = meta.get('node.role')
    const role: NodeRole =
      rawRole === 'parent' || rawRole === 'child' ? rawRole : 'standalone'
    const listenHost = meta.get('node.listen_host')?.trim() || '0.0.0.0'
    const rawPort = Number(meta.get('node.listen_port'))
    const listenPort = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 7432
    const hasToken = Boolean(meta.get('node.auth_token')?.trim())
    const authToken = hasToken ? '***redacted***' : null
    const autoSync = meta.get('node.auto_sync') !== 'false'
    const lanDiscovery = meta.get('node.lan_discovery') !== 'false'
    const unassignedGroupPolicy: UnassignedGroupPolicy =
      meta.get('node.unassigned_group_policy') === 'all' ? 'all' : 'none'

    return {
      nodeId,
      nodeName,
      enabled,
      role,
      listenHost,
      listenPort,
      authToken,
      autoSync,
      lanDiscovery,
      unassignedGroupPolicy,
    }
  }

  listPeers(): SyncPeerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sync_peers ORDER BY updated_at DESC`)
      .all() as Array<{
      id: string
      peer_node_id: string | null
      role: string
      name: string
      url: string
      last_sync_at: string | null
      last_status: string | null
      updated_at: string
    }>

    return rows.map((row) => ({
      id: row.id,
      peerNodeId: row.peer_node_id ?? null,
      role: row.role === 'parent' ? 'parent' : 'child',
      name: row.name,
      url: row.url,
      lastSyncAt: row.last_sync_at ?? null,
      lastStatus: row.last_status ?? null,
      updatedAt: row.updated_at,
    }))
  }

  listGroups(): SyncGroupRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sync_groups ORDER BY name ASC`)
      .all() as Array<{
      id: string
      name: string
      description: string
      projects: string
      categories: string
      permissions: string
      created_at: string
      updated_at: string
    }>

    return rows.map((row) => {
      const members = this.db
        .prepare(
          `SELECT peer_identifier FROM sync_group_members
           WHERE group_id = ?
           ORDER BY added_at ASC`
        )
        .all(row.id) as Array<{ peer_identifier: string }>

      let projects: string[] = ['*']
      try {
        const parsed = JSON.parse(row.projects)
        if (Array.isArray(parsed)) projects = parsed.map(String)
      } catch {}

      let categories: string[] = ['*']
      try {
        const parsed = JSON.parse(row.categories)
        if (Array.isArray(parsed)) categories = parsed.map(String)
      } catch {}

      const permissions: GroupPermissionMode =
        row.permissions === 'readonly' || row.permissions === 'writeonly'
          ? row.permissions
          : 'readwrite'

      return {
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        projects,
        categories,
        permissions,
        memberNodeIds: members.map((m) => m.peer_identifier),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  getFingerprint(): string {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS mem_cnt,
           COALESCE(MAX(updated_at), '') AS max_upd,
           (SELECT COUNT(*) FROM memory_tombstones) AS tomb_cnt,
           (SELECT COALESCE(MAX(deleted_at), '') FROM memory_tombstones) AS max_del
         FROM memories`
      )
      .get() as {
      mem_cnt: number
      max_upd: string
      tomb_cnt: number
      max_del: string
    }
    return `${row.mem_cnt}:${row.max_upd}:${row.tomb_cnt}:${row.max_del}`
  }

  close(): void {
    this.db.close()
  }
}
