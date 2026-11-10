import fs from 'node:fs'
import path from 'node:path'
import type { VaultBridge } from './vault-bridge.ts'

export interface VaultWatcherOptions {
  bridge: VaultBridge
  pollIntervalMs?: number
  onChange: (fingerprint: string) => void
}

export class VaultWatcher {
  private readonly bridge: VaultBridge
  private readonly onChange: (fingerprint: string) => void
  private readonly pollIntervalMs: number
  private lastFingerprint: string
  private fsWatcher: fs.FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: VaultWatcherOptions) {
    this.bridge = options.bridge
    this.onChange = options.onChange
    this.pollIntervalMs = options.pollIntervalMs ?? 1200
    this.lastFingerprint = this.safeFingerprint()
  }

  private safeFingerprint(): string {
    try {
      return this.bridge.getFingerprint()
    } catch {
      return ''
    }
  }

  private checkAndEmit(): void {
    const next = this.safeFingerprint()
    if (next && next !== this.lastFingerprint) {
      this.lastFingerprint = next
      this.onChange(next)
    }
  }

  start(): void {
    if (this.bridge.dbPath !== ':memory:') {
      const dir = path.dirname(this.bridge.dbPath)
      const base = path.basename(this.bridge.dbPath)
      try {
        if (fs.existsSync(dir)) {
          this.fsWatcher = fs.watch(dir, (_event, filename) => {
            if (!filename || filename.startsWith(base)) {
              if (this.debounceTimer) clearTimeout(this.debounceTimer)
              this.debounceTimer = setTimeout(() => {
                this.checkAndEmit()
              }, 180)
            }
          })
        }
      } catch {
        // Fallback to polling if fs.watch is unavailable
      }
    }

    this.pollTimer = setInterval(() => {
      this.checkAndEmit()
    }, this.pollIntervalMs)
    if (this.pollTimer.unref) {
      this.pollTimer.unref()
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close()
      } catch {}
      this.fsWatcher = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}
