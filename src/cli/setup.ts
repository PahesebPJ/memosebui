import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BUNDLE_ID, PACKAGE_ROOT, VERSION } from '../version.ts'

export const PROVIDES = ['ui.memoseb', 'memory.visualizer']
export const CONSUMES = ['memory.vault']
export const SIGNALS = ['memosebui.launched', 'memory.inspected']

export interface TopologyNode {
  id: string
  version: string
  summary: string
  command: string[]
  provides: string[]
  consumes: string[]
  signals: string[]
  triggers: string[]
  registeredAt: string
}

export interface HubsebTopology {
  schema: string
  updatedAt: string
  nodes: Record<string, TopologyNode>
}

export interface SetupOptions {
  topologyPath?: string
}

export function getDefaultTopologyPath(): string {
  return path.join(os.homedir(), '.config', 'hubseb', 'topology.json')
}

export function getMemosebuiPidPath(): string {
  return path.join(os.homedir(), '.config', 'hubseb', 'memosebui.pid')
}

export function buildMemosebuiNodeRegistration(): TopologyNode {
  const distBin = path.join(PACKAGE_ROOT, 'dist', 'cli', 'memosebui.js')
  const srcBin = path.join(PACKAGE_ROOT, 'src', 'cli', 'memosebui.ts')
  const scriptPath = fsSync.existsSync(distBin) ? distBin : srcBin

  return {
    id: BUNDLE_ID,
    version: VERSION,
    summary:
      'Interactive force-directed memory graph and desktop interface for memoseb',
    command: [path.resolve(process.execPath), path.resolve(scriptPath)],
    provides: [...PROVIDES],
    consumes: [...CONSUMES],
    signals: [...SIGNALS],
    triggers: [],
    registeredAt: new Date().toISOString(),
  }
}

export async function registerMemosebuiNode(
  options?: SetupOptions
): Promise<{ success: boolean; topologyFile: string; node: TopologyNode }> {
  const topologyFile = options?.topologyPath ?? getDefaultTopologyPath()
  const dir = path.dirname(topologyFile)

  await fs.mkdir(dir, { recursive: true })

  let topology: HubsebTopology
  try {
    const raw = await fs.readFile(topologyFile, 'utf8')
    topology = JSON.parse(raw) as HubsebTopology
    if (!topology.nodes || typeof topology.nodes !== 'object') {
      topology.nodes = {}
    }
  } catch {
    topology = {
      schema: 'hubseb-topology/v1',
      updatedAt: new Date().toISOString(),
      nodes: {},
    }
  }

  const node = buildMemosebuiNodeRegistration()
  topology.nodes[BUNDLE_ID] = node
  topology.updatedAt = new Date().toISOString()

  await fs.writeFile(topologyFile, JSON.stringify(topology, null, 2), 'utf8')

  if (!options?.topologyPath) {
    try {
      const stateTopologyFile = path.join(
        os.homedir(),
        '.local',
        'state',
        'hubseb',
        'topology.json'
      )
      if (fsSync.existsSync(path.dirname(stateTopologyFile))) {
        let stateTopo: HubsebTopology
        try {
          stateTopo = JSON.parse(
            await fs.readFile(stateTopologyFile, 'utf8')
          ) as HubsebTopology
          if (!stateTopo.nodes || typeof stateTopo.nodes !== 'object') {
            stateTopo.nodes = {}
          }
        } catch {
          stateTopo = {
            schema: 'hubseb-topology/v1',
            updatedAt: new Date().toISOString(),
            nodes: {},
          }
        }
        stateTopo.nodes[BUNDLE_ID] = node
        stateTopo.updatedAt = new Date().toISOString()
        await fs.writeFile(
          stateTopologyFile,
          JSON.stringify(stateTopo, null, 2),
          'utf8'
        )
      }
    } catch {
      // Graceful degradation
    }
  }

  return {
    success: true,
    topologyFile,
    node,
  }
}

export async function unregisterMemosebuiNode(
  options?: SetupOptions
): Promise<{ success: boolean; removed: boolean; topologyFile: string }> {
  const topologyFile = options?.topologyPath ?? getDefaultTopologyPath()

  if (!fsSync.existsSync(topologyFile)) {
    return {
      success: true,
      removed: false,
      topologyFile,
    }
  }

  try {
    const raw = await fs.readFile(topologyFile, 'utf8')
    const topology = JSON.parse(raw) as HubsebTopology
    if (!topology.nodes || !(BUNDLE_ID in topology.nodes)) {
      return {
        success: true,
        removed: false,
        topologyFile,
      }
    }

    delete topology.nodes[BUNDLE_ID]
    topology.updatedAt = new Date().toISOString()

    await fs.writeFile(topologyFile, JSON.stringify(topology, null, 2), 'utf8')

    return {
      success: true,
      removed: true,
      topologyFile,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to unregister memosebui from ${topologyFile}: ${msg}`)
  }
}

export async function isMemosebuiRegistered(
  options?: SetupOptions
): Promise<boolean> {
  const topologyFile = options?.topologyPath ?? getDefaultTopologyPath()
  try {
    if (!fsSync.existsSync(topologyFile)) return false
    const raw = await fs.readFile(topologyFile, 'utf8')
    const topology = JSON.parse(raw) as HubsebTopology
    return Boolean(topology.nodes && BUNDLE_ID in topology.nodes)
  } catch {
    return false
  }
}

export async function startMemosebuiDaemon(
  port = 4322
): Promise<{ started: boolean; pid?: number; url: string }> {
  const url = `http://127.0.0.1:${port}`

  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(400),
    })
    if (res.ok) {
      let existingPid: number | undefined
      try {
        const pidFile = getMemosebuiPidPath()
        if (fsSync.existsSync(pidFile)) {
          const rawPid = fsSync.readFileSync(pidFile, 'utf8').trim()
          const parsed = parseInt(rawPid, 10)
          if (!Number.isNaN(parsed)) existingPid = parsed
        }
      } catch {}
      return { started: false, pid: existingPid, url }
    }
  } catch {
    // Not running yet
  }

  const distBin = path.join(PACKAGE_ROOT, 'dist', 'cli', 'memosebui.js')
  const srcBin = path.join(PACKAGE_ROOT, 'src', 'cli', 'memosebui.ts')
  const scriptPath = fsSync.existsSync(distBin) ? distBin : srcBin

  const pidFile = getMemosebuiPidPath()
  await fs.mkdir(path.dirname(pidFile), { recursive: true })

  const child = spawn(
    process.execPath,
    [scriptPath, 'watch', '--port', String(port)],
    {
      detached: true,
      stdio: 'ignore',
    }
  )

  const pid = child.pid
  if (pid) {
    await fs.writeFile(pidFile, String(pid), 'utf8')
  }
  child.unref()

  const startTime = Date.now()
  while (Date.now() - startTime < 2500) {
    try {
      const ping = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(250),
      })
      if (ping.ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  return { started: true, pid, url }
}

export async function stopMemosebuiDaemon(): Promise<boolean> {
  const pidFile = getMemosebuiPidPath()
  if (!fsSync.existsSync(pidFile)) {
    return false
  }

  let stopped = false
  try {
    const raw = await fs.readFile(pidFile, 'utf8')
    const pid = parseInt(raw.trim(), 10)
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM')
        stopped = true
      } catch {}
    }
  } catch {
    // ignore
  } finally {
    try {
      await fs.unlink(pidFile)
    } catch {}
  }

  return stopped
}
