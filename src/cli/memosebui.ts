#!/usr/bin/env node
import {
  getDefaultTopologyPath,
  isMemosebuiRegistered,
  registerMemosebuiNode,
  startMemosebuiDaemon,
  stopMemosebuiDaemon,
  unregisterMemosebuiNode,
} from './setup.ts'
import {
  isMemosebuiServerRunning,
  launchStandaloneDesktopWindow,
  startUiServer,
} from './ui-server.ts'
import { BUNDLE_ID, VERSION } from '../version.ts'

function printHelp(): void {
  console.log(`
🧠 ${BUNDLE_ID} v${VERSION} — Visor Neuronal e Interfaz de Escritorio para memoseb

Uso:
  memosebui [ui|watch] [--port 4322] [--project <id>] [--open] [--browser] [--daemon]
      Inicia la interfaz interactiva de nodos para memoseb y actualiza el grafo en tiempo real vía SSE.

  memosebui daemon [--port 4322]
      Arranca el servidor de memosebui como daemon desacoplado en segundo plano.

  memosebui stop
      Detiene el daemon de memosebui si está en ejecución.

  memosebui status [--json]
      Muestra el estado del visor, métricas de vault.sqlite y registro en hubseb.

  memosebui setup [--no-daemon]
      Registra memosebui en hubseb topology.json y arranca el daemon en segundo plano.

  memosebui purge
      Detiene el daemon de memosebui y lo elimina de la topología de hubseb.

  memosebui --version, -v
      Muestra la versión de memosebui.

  memosebui --help, -h
      Muestra esta ayuda.
`)
}

function extractPort(args: string[], defaultPort = 4322): number {
  const idx = args.indexOf('--port')
  if (idx !== -1 && args[idx + 1]) {
    const val = parseInt(args[idx + 1]!, 10)
    if (!Number.isNaN(val) && val > 0) return val
  }
  return defaultPort
}

function extractProject(args: string[]): string | undefined {
  const idx = args.indexOf('--project')
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1]
  }
  return undefined
}

async function handleStatus(jsonMode: boolean, port: number): Promise<void> {
  const registered = await isMemosebuiRegistered()
  let serverActive = false
  let memoryCount = 0
  let projectCount = 0

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/graph`, {
      signal: AbortSignal.timeout(600),
    })
    if (res.ok) {
      serverActive = true
      const data = (await res.json()) as {
        stats?: { memoryCount?: number; projectCount?: number }
      }
      memoryCount = data.stats?.memoryCount ?? 0
      projectCount = data.stats?.projectCount ?? 0
    }
  } catch {
    serverActive = false
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          version: VERSION,
          bundleId: BUNDLE_ID,
          registeredInTopology: registered,
          topologyPath: getDefaultTopologyPath(),
          uiServer: {
            port,
            status: serverActive ? 'running' : 'stopped',
            projectCount,
            memoryCount,
          },
        },
        null,
        2
      )
    )
    return
  }

  console.log(`\n🧠 memosebui v${VERSION} — Estado del Visor Neuronal:`)
  console.log(`  • Registrado en hubseb:     ${registered ? '✅ SÍ' : '❌ NO'}`)
  console.log(
    `  • Servidor Visor (:${port}):    ${
      serverActive
        ? `🟢 ACTIVO (${projectCount} proyectos · ${memoryCount} recuerdos)`
        : '⚪ INACTIVO'
    }`
  )
  console.log(`  • Topología:                ${getDefaultTopologyPath()}\n`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const firstArg = args[0]
  const jsonMode = args.includes('--json')
  const port = extractPort(args, 4322)
  const initialProject = extractProject(args)

  if (firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    printHelp()
    return
  }

  if (firstArg === '--version' || firstArg === '-v' || firstArg === 'version') {
    console.log(`${BUNDLE_ID} v${VERSION}`)
    return
  }

  if (
    firstArg === 'daemon' ||
    ((!firstArg || firstArg === 'watch' || firstArg === 'ui') &&
      args.includes('--daemon'))
  ) {
    const result = await startMemosebuiDaemon(port)
    if (result.started) {
      console.log(`🧠 Daemon de memosebui iniciado (PID ${result.pid}) en ${result.url}`)
    } else {
      console.log(`🧠 Daemon de memosebui ya está activo en ${result.url}`)
    }
    return
  }

  if (firstArg === 'stop') {
    const stopped = await stopMemosebuiDaemon()
    if (stopped) {
      console.log(`🛑 Daemon de memosebui detenido`)
    } else {
      console.log(`ℹ️ No se encontró ningún daemon de memosebui en ejecución`)
    }
    return
  }

  if (!firstArg || firstArg === 'ui') {
    const useBrowser = args.includes('--browser')
    const daemon = await startMemosebuiDaemon(port)
    const targetUrl = initialProject
      ? `${daemon.url}/?project=${encodeURIComponent(initialProject)}`
      : daemon.url

    launchStandaloneDesktopWindow(targetUrl, useBrowser)

    if (daemon.started) {
      console.log(
        `🚀 Daemon de memosebui iniciado (PID ${daemon.pid}) y ventana abierta en ${targetUrl}`
      )
    } else {
      console.log(
        `✨ Conectado al daemon activo en ${daemon.url} — abriendo ventana de escritorio (${targetUrl})`
      )
    }
    return
  }

  if (firstArg === 'watch') {
    const useBrowser = args.includes('--browser')
    const openWindow = args.includes('--open')
    const alreadyRunning = await isMemosebuiServerRunning(port)

    if (alreadyRunning) {
      const targetUrl = initialProject
        ? `http://127.0.0.1:${port}/?project=${encodeURIComponent(initialProject)}`
        : `http://127.0.0.1:${port}`
      if (openWindow || useBrowser) {
        launchStandaloneDesktopWindow(targetUrl, useBrowser)
      }
      console.log(
        `ℹ️ El servidor de memosebui ya está activo en http://127.0.0.1:${port}`
      )
      return
    }

    console.log(
      `\n🚀 Iniciando memosebui Visor Neuronal en http://127.0.0.1:${port}`
    )
    const instance = await startUiServer({
      port,
      initialProject,
      openWindow,
      openBrowser: useBrowser,
    })
    const shutdown = async () => {
      await instance.close()
      process.exit(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    console.log(
      `✨ Grafo de memoria activo en ${instance.url} (Presiona Ctrl+C para salir)\n`
    )
    return
  }

  switch (firstArg) {
    case 'status': {
      await handleStatus(jsonMode, port)
      break
    }
    case 'setup': {
      const outcome = await registerMemosebuiNode()
      console.log(`✅ ${BUNDLE_ID} registrado en ${outcome.topologyFile}`)
      if (!args.includes('--no-daemon')) {
        const daemon = await startMemosebuiDaemon(port)
        if (daemon.started) {
          console.log(
            `🚀 Daemon activo sincronizando grafo en ${daemon.url} (PID: ${daemon.pid})`
          )
        } else {
          console.log(`ℹ️ Daemon ya activo en ${daemon.url}`)
        }
      }
      break
    }
    case 'purge': {
      await stopMemosebuiDaemon()
      const outcome = await unregisterMemosebuiNode()
      if (outcome.removed) {
        console.log(`🧹 ${BUNDLE_ID} eliminado de ${outcome.topologyFile}`)
      } else {
        console.log(`ℹ️ ${BUNDLE_ID} no estaba registrado en ${outcome.topologyFile}`)
      }
      break
    }
    default: {
      console.error(`Comando desconocido: ${firstArg}`)
      printHelp()
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error('Fatal CLI error:', err)
  process.exit(1)
})
