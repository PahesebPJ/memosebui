import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { buildMindGraph } from '../core/graph-builder.ts'
import { isMemoryCategory, VaultBridge } from '../core/vault-bridge.ts'
import { VaultWatcher } from '../core/vault-watcher.ts'
import type { MemoryCategory, MindGraphSnapshot } from '../types/mind.ts'
import { PACKAGE_ROOT } from '../version.ts'

export interface UiServerOptions {
  port?: number
  host?: string
  dbPath?: string
  openBrowser?: boolean
  openWindow?: boolean
  initialProject?: string
  disableWatcher?: boolean
}

export interface UiServerInstance {
  server: http.Server
  port: number
  url: string
  bridge: VaultBridge
  close: () => Promise<void>
  broadcastEvent: (type: string, payload?: Record<string, unknown>) => void
  getSnapshot: (projectId?: string, category?: MemoryCategory) => MindGraphSnapshot
}

function findExecutableInPath(binName: string): string | null {
  const pathEnv = process.env.PATH || ''
  const dirs = pathEnv.split(path.delimiter).filter(Boolean)
  const extensions =
    process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binName}${ext}`)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK)
          return candidate
        }
      } catch {
        // Not executable, continue
      }
    }
  }
  return null
}

function spawnDetached(command: string, args: string[]): boolean {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
    return Boolean(child.pid)
  } catch {
    return false
  }
}

export async function isMindsebServerRunning(
  port: number,
  host = '127.0.0.1'
): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/api/graph`, {
      signal: AbortSignal.timeout(450),
    })
    if (!res.ok) return false
    const data = (await res.json()) as Record<string, unknown>
    return Boolean(data && typeof data === 'object' && 'nodes' in data && 'edges' in data)
  } catch {
    return false
  }
}

export function launchStandaloneDesktopWindow(
  url: string,
  forceBrowser = false
): void {
  if (forceBrowser) {
    if (process.platform === 'darwin') {
      spawnDetached('open', [url])
    } else if (process.platform === 'win32') {
      spawnDetached('cmd.exe', ['/c', 'start', '', url])
    } else {
      spawnDetached('xdg-open', [url])
    }
    return
  }

  const appArgs = [
    `--app=${url}`,
    '--window-size=1360,860',
    '--class=mindseb',
  ]

  if (process.platform === 'linux') {
    const omarchyWebapp = findExecutableInPath('omarchy-launch-webapp')
    if (omarchyWebapp) {
      if (
        spawnDetached(omarchyWebapp, [
          url,
          '--window-size=1360,860',
          '--class=mindseb',
        ])
      ) {
        return
      }
    }

    const candidates = [
      'chromium',
      'google-chrome',
      'google-chrome-stable',
      'brave',
      'brave-browser',
      'microsoft-edge',
    ]
    for (const bin of candidates) {
      const resolved = findExecutableInPath(bin)
      if (resolved && spawnDetached(resolved, appArgs)) {
        return
      }
    }
    spawnDetached('xdg-open', [url])
    return
  }

  if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    for (const bin of macCandidates) {
      if (existsSync(bin) && spawnDetached(bin, appArgs)) {
        return
      }
    }
    spawnDetached('open', [url])
    return
  }

  if (process.platform === 'win32') {
    const winCandidates = ['msedge', 'chrome', 'brave']
    for (const bin of winCandidates) {
      const resolved = findExecutableInPath(bin)
      if (resolved && spawnDetached(resolved, appArgs)) {
        return
      }
    }
    spawnDetached('cmd.exe', ['/c', 'start', '', url])
    return
  }

  spawnDetached('xdg-open', [url])
}

export function generateMindUiHtml(initialProject = 'all'): string {
  return `<!DOCTYPE html>
<html lang="es" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mindseb — Visor Neuronal de Memoria para memoseb</title>
  <link rel="stylesheet" href="/styles/mind.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🧠</text></svg>">
</head>
<body>
  <div class="mind-shell">
    <header class="mind-topbar">
      <div class="topbar-left">
        <div class="traffic-lights">
          <span class="traffic-light close" title="Cerrar"></span>
          <span class="traffic-light minimize" title="Minimizar"></span>
          <span class="traffic-light maximize" title="Maximizar"></span>
        </div>
        <span class="brand-badge">🧠 mindseb</span>
        <span id="liveIndicator" class="live-indicator">
          <span id="liveDot" class="live-dot"></span>
          <span id="liveText">Conectando…</span>
        </span>
      </div>

      <div class="topbar-center">
        <select id="projectSelector" class="mind-select" aria-label="Filtrar por proyecto">
          <option value="all">Todos los proyectos</option>
        </select>

        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input id="searchInput" type="text" class="search-input" placeholder="Búsqueda híbrida RRF (vector + FTS5)…" autocomplete="off" />
          <span class="search-kbd">⌘K</span>
        </div>

        <button id="groupToggleBtn" class="btn" title="Agrupar por anillos de categoría">
          <span>◎ Categorías</span>
        </button>
      </div>

      <div class="topbar-right">
        <button id="newMemoryBtn" class="btn btn-primary" title="Registrar nuevo recuerdo en memoseb">
          <span>＋ Recuerdo</span>
        </button>
        <button id="analyzeBtn" class="btn" title="Analizar un repositorio con memoseb analyze">
          <span>⚡ Analizar Repo</span>
        </button>
        <button id="p2pToggleBtn" class="btn" title="Ver topología de red P2P y Grupos ACL">
          <span>🌐 Red P2P / ACL</span>
        </button>
        <button id="themeToggleBtn" class="btn" title="Alternar tema Oscuro / Claro">
          <span id="themeIcon">☀️</span>
        </button>
      </div>
    </header>

    <div class="mind-workspace">
      <div class="graph-stage">
        <div class="floating-filters" id="categoryFilters">
          <button class="cat-chip active" data-cat="all">Todas</button>
          <button class="cat-chip" data-cat="architecture"><span class="cat-dot" style="background:#38bdf8"></span>architecture</button>
          <button class="cat-chip" data-cat="convention"><span class="cat-dot" style="background:#a855f7"></span>convention</button>
          <button class="cat-chip" data-cat="bugfix"><span class="cat-dot" style="background:#f97316"></span>bugfix</button>
          <button class="cat-chip" data-cat="decision"><span class="cat-dot" style="background:#10b981"></span>decision</button>
          <button class="cat-chip" data-cat="domain"><span class="cat-dot" style="background:#6366f1"></span>domain</button>
        </div>

        <canvas id="mindCanvas"></canvas>

        <div class="floating-hud">
          <div class="hud-slider-group">
            <span>Similitud Vectorial:</span>
            <input id="simSlider" type="range" min="0.20" max="0.80" step="0.02" value="0.38" />
            <strong id="simValueLabel">38%</strong>
          </div>
          <span>·</span>
          <button id="resetViewBtn" class="btn" style="height:26px;padding:0 8px;font-size:11px;">Centrar Vista</button>
          <span id="graphMetricsLabel">0 nodos · 0 enlaces</span>
        </div>

        <!-- P2P & ACL Overlay View -->
        <section id="p2pPanel" class="p2p-panel" aria-label="Red P2P y Grupos ACL">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <h2 style="font-size:17px;font-weight:700;">🌐 Topología P2P y Grupos ACL de memoseb</h2>
              <p style="font-size:12px;color:var(--text-secondary);margin-top:2px;">Estado del nodo local, peers federados y permisos de sincronización por proyecto/categoría.</p>
            </div>
            <button id="closeP2pBtn" class="btn">Cerrar vista P2P</button>
          </div>
          <div id="p2pContent" class="p2p-grid"></div>
        </section>
      </div>

      <!-- Right Inspector Drawer -->
      <aside class="inspector-drawer" id="inspectorDrawer">
        <div class="inspector-header">
          <span class="inspector-title" id="inspectorHeaderTitle">Inspector de Nodo</span>
          <div style="display:flex;gap:6px;" id="inspectorActions"></div>
        </div>
        <div class="inspector-body" id="inspectorBody">
          <p style="color:var(--text-secondary);font-size:13px;">Haz clic en cualquier nodo del grafo o realiza una búsqueda híbrida para inspeccionar su contenido, vectores semánticos y conexiones.</p>
        </div>
      </aside>
    </div>

    <!-- Modal: Create / Edit Memory -->
    <div id="memoryModal" class="modal-backdrop">
      <form id="memoryForm" class="modal-card">
        <h3 id="modalTitle" style="font-size:16px;font-weight:700;">Nuevo Recuerdo en memoseb</h3>
        <input type="hidden" id="editMemoryId" value="" />
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-field">
            <label for="memProjectInput">Proyecto (slug)</label>
            <input id="memProjectInput" class="form-input" type="text" placeholder="ej. memoseb, deckseb, global" required />
          </div>
          <div class="form-field">
            <label for="memCategoryInput">Categoría</label>
            <select id="memCategoryInput" class="form-select">
              <option value="architecture">architecture</option>
              <option value="convention">convention</option>
              <option value="bugfix">bugfix</option>
              <option value="decision">decision</option>
              <option value="domain">domain</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <label for="memTitleInput">Título del aprendizaje</label>
          <input id="memTitleInput" class="form-input" type="text" placeholder="Ej. Motor de persistencia híbrido SQLite WAL" required />
        </div>
        <div class="form-field">
          <label for="memContentInput">Contenido detallado</label>
          <textarea id="memContentInput" class="form-textarea" placeholder="Describe la decisión arquitectónica, convención o causa raíz…" required></textarea>
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
          <div class="form-field">
            <label for="memTagsInput">Etiquetas (separadas por coma)</label>
            <input id="memTagsInput" class="form-input" type="text" placeholder="sqlite, fts5, vectors" />
          </div>
          <div class="form-field">
            <label for="memImportanceInput">Importancia (0.1 - 1.0)</label>
            <input id="memImportanceInput" class="form-input" type="number" min="0.1" max="1.0" step="0.05" value="0.8" />
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
          <button type="button" id="cancelMemoryModalBtn" class="btn">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar en Bóveda</button>
        </div>
      </form>
    </div>

    <!-- Modal: Analyze Repository -->
    <div id="analyzeModal" class="modal-backdrop">
      <form id="analyzeForm" class="modal-card">
        <h3 style="font-size:16px;font-weight:700;">⚡ Analizar Repositorio con memoseb</h3>
        <p style="font-size:12.5px;color:var(--text-secondary);">Inspecciona manifiestos, scripts y topología del directorio para sintetizar automáticamente sus nodos base (architecture, convention y domain).</p>
        <div class="form-field">
          <label for="analyzePathInput">Ruta absoluta del repositorio</label>
          <input id="analyzePathInput" class="form-input" type="text" placeholder="/home/alan/Documents/projects/mi-proyecto" required />
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
          <button type="button" id="cancelAnalyzeModalBtn" class="btn">Cancelar</button>
          <button type="submit" class="btn btn-primary">Ejecutar Análisis</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    (function() {
      const INITIAL_PROJECT = ${JSON.stringify(initialProject)};
      const queryProject = new URLSearchParams(window.location.search).get('project');
      let currentProject = queryProject || INITIAL_PROJECT || 'all';
      let currentCategory = 'all';
      let minSimilarity = 0.38;
      let groupByCategory = false;

      let snapshot = null;
      let simNodes = [];
      let simEdges = [];
      let particles = [];
      let ripples = [];
      let selectedNodeId = null;
      let hoveredNodeId = null;
      let draggedNode = null;
      let searchScoresById = new Map();

      // Camera transform
      let camX = 0;
      let camY = 0;
      let camScale = 1;
      let targetCamX = 0;
      let targetCamY = 0;
      let targetCamScale = 1;
      let isPanning = false;
      let panStartX = 0;
      let panStartY = 0;

      const canvas = document.getElementById('mindCanvas');
      const ctx = canvas.getContext('2d');
      const projectSelector = document.getElementById('projectSelector');
      const searchInput = document.getElementById('searchInput');
      const simSlider = document.getElementById('simSlider');
      const simValueLabel = document.getElementById('simValueLabel');
      const graphMetricsLabel = document.getElementById('graphMetricsLabel');
      const liveDot = document.getElementById('liveDot');
      const liveText = document.getElementById('liveText');
      const inspectorHeaderTitle = document.getElementById('inspectorHeaderTitle');
      const inspectorActions = document.getElementById('inspectorActions');
      const inspectorBody = document.getElementById('inspectorBody');
      const groupToggleBtn = document.getElementById('groupToggleBtn');
      const p2pToggleBtn = document.getElementById('p2pToggleBtn');
      const p2pPanel = document.getElementById('p2pPanel');
      const p2pContent = document.getElementById('p2pContent');

      function escapeHtml(str) {
        return String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // Theme
      function initTheme() {
        const saved = localStorage.getItem('mindseb-theme') || 'dark';
        applyTheme(saved);
      }
      function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('mindseb-theme', theme);
        const icon = document.getElementById('themeIcon');
        if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
      }
      document.getElementById('themeToggleBtn').addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        applyTheme(cur === 'dark' ? 'light' : 'dark');
      });

      // Resize HiDPI Canvas
      function resizeCanvas() {
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (camX === 0 && camY === 0) {
          camX = targetCamX = rect.width / 2;
          camY = targetCamY = rect.height / 2;
        }
      }
      window.addEventListener('resize', resizeCanvas);
      resizeCanvas();

      function resetCamera() {
        const rect = canvas.parentElement.getBoundingClientRect();
        targetCamX = rect.width / 2;
        targetCamY = rect.height / 2;
        targetCamScale = 1;
      }
      document.getElementById('resetViewBtn').addEventListener('click', resetCamera);

      // Load Graph Snapshot
      async function loadGraph(spawnRippleForId) {
        const params = new URLSearchParams({
          project: currentProject,
          category: currentCategory,
          minSimilarity: String(minSimilarity),
          groupByCategory: String(groupByCategory),
        });
        const res = await fetch('/api/graph?' + params.toString());
        if (!res.ok) return;
        snapshot = await res.json();

        updateProjectDropdown(snapshot.projects);
        liveText.textContent =
          'En vivo · ' +
          snapshot.stats.memoryCount +
          ' recuerdos · ' +
          snapshot.stats.totalTokens.toLocaleString() +
          ' tokens';
        graphMetricsLabel.textContent =
          snapshot.nodes.length + ' nodos · ' + snapshot.edges.length + ' enlaces';

        syncPhysicsGraph(snapshot, spawnRippleForId);
        renderP2pView(snapshot.p2p);

        if (selectedNodeId) {
          const found = simNodes.find(n => n.id === selectedNodeId);
          if (found) renderInspectorForNode(found);
          else renderOverviewInspector();
        } else {
          renderOverviewInspector();
        }
      }

      function updateProjectDropdown(projects) {
        const prev = currentProject;
        projectSelector.innerHTML = '<option value="all">Todos los proyectos (' + projects.length + ')</option>';
        projects.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name + ' (' + p.memoryCount + ')';
          if (p.id === prev) opt.selected = true;
          projectSelector.appendChild(opt);
        });
      }

      function syncPhysicsGraph(snap, highlightNewId) {
        const oldPos = new Map();
        simNodes.forEach(n => {
          oldPos.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy, pinned: n.pinned });
        });

        const projCount = Math.max(1, snap.nodes.filter(n => n.type === 'project').length);
        let projIndex = 0;
        const projCenters = new Map();

        simNodes = snap.nodes.map((n, idx) => {
          const existing = oldPos.get(n.id);
          if (existing) {
            return Object.assign({}, n, existing);
          }
          let x = 0;
          let y = 0;
          if (n.type === 'project') {
            const angle = (projIndex / projCount) * Math.PI * 2;
            const ringR = projCount === 1 ? 0 : 190;
            x = Math.cos(angle) * ringR;
            y = Math.sin(angle) * ringR;
            projCenters.set(n.projectId, { x, y });
            projIndex++;
          } else {
            const center = projCenters.get(n.projectId) || { x: 0, y: 0 };
            const a = (idx * 2.39996) % (Math.PI * 2);
            const r = 70 + (idx % 5) * 26;
            x = center.x + Math.cos(a) * r;
            y = center.y + Math.sin(a) * r;
          }
          if (highlightNewId && n.memoryId === highlightNewId) {
            ripples.push({ x, y, r: n.radius, maxR: 95, alpha: 1, color: n.color });
          }
          return Object.assign({}, n, { x, y, vx: 0, vy: 0, pinned: false, phase: Math.random() * Math.PI * 2 });
        });

        const nodeMap = new Map(simNodes.map(n => [n.id, n]));
        simEdges = snap.edges
          .map(e => ({
            ...e,
            sourceNode: nodeMap.get(e.source),
            targetNode: nodeMap.get(e.target),
          }))
          .filter(e => e.sourceNode && e.targetNode);

        // Rebuild synaptic particles along edges
        particles = simEdges.slice(0, 80).map((edge, i) => ({
          edge,
          t: (i * 0.17) % 1,
          speed: edge.kind === 'semantic-similarity' ? 0.0055 : 0.0038,
        }));
      }

      // Physics Step & 60fps Canvas Render
      let frameTick = 0;
      function stepAndRender() {
        frameTick += 0.035;
        const rect = canvas.parentElement.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;

        // Smooth camera interpolation
        camX += (targetCamX - camX) * 0.14;
        camY += (targetCamY - camY) * 0.14;
        camScale += (targetCamScale - camScale) * 0.14;

        // 1. Physics forces
        const N = simNodes.length;
        for (let i = 0; i < N; i++) {
          const a = simNodes[i];
          if (!a.pinned && a !== draggedNode) {
            // Soft centering gravity
            const grav = a.type === 'project' ? 0.0018 : 0.0007;
            a.vx -= a.x * grav;
            a.vy -= a.y * grav;
          }
          for (let j = i + 1; j < N; j++) {
            const b = simNodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 4) {
              dx = (Math.random() - 0.5) * 2;
              dy = (Math.random() - 0.5) * 2;
              distSq = 4;
            }
            const dist = Math.sqrt(distSq);
            const minGap = a.radius + b.radius + 26;
            const repulse = (a.type === 'project' || b.type === 'project') ? 2600 : 1250;
            if (dist < 360) {
              let force = repulse / distSq;
              if (dist < minGap) force += (minGap - dist) * 0.12;
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              if (!a.pinned && a !== draggedNode) { a.vx -= fx; a.vy -= fy; }
              if (!b.pinned && b !== draggedNode) { b.vx += fx; b.vy += fy; }
            }
          }
        }

        // Spring forces on edges
        for (let i = 0; i < simEdges.length; i++) {
          const e = simEdges[i];
          const s = e.sourceNode;
          const t = e.targetNode;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetLen =
            e.kind === 'project-memory' ? 118 :
            e.kind === 'project-category' ? 88 :
            e.kind === 'category-memory' ? 78 :
            e.kind === 'semantic-similarity' ? 145 : 160;
          const k = e.kind === 'semantic-similarity' ? 0.014 * e.weight : 0.032;
          const f = (dist - targetLen) * k;
          const fx = (dx / dist) * f;
          const fy = (dy / dist) * f;
          if (!s.pinned && s !== draggedNode) { s.vx += fx; s.vy += fy; }
          if (!t.pinned && t !== draggedNode) { t.vx -= fx; t.vy -= fy; }
        }

        // Integrate velocities
        for (let i = 0; i < N; i++) {
          const n = simNodes[i];
          if (n.pinned || n === draggedNode) {
            n.vx = 0;
            n.vy = 0;
            continue;
          }
          n.vx *= 0.82;
          n.vy *= 0.82;
          n.x += n.vx;
          n.y += n.vy;
        }

        // 2. Render Canvas
        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.translate(camX, camY);
        ctx.scale(camScale, camScale);

        const activeFocusId = hoveredNodeId || selectedNodeId;
        const neighborIds = new Set();
        if (activeFocusId) {
          neighborIds.add(activeFocusId);
          simEdges.forEach(e => {
            if (e.source === activeFocusId) neighborIds.add(e.target);
            if (e.target === activeFocusId) neighborIds.add(e.source);
          });
        }

        // Draw Edges
        for (let i = 0; i < simEdges.length; i++) {
          const e = simEdges[i];
          const s = e.sourceNode;
          const t = e.targetNode;
          const isHighlighted =
            activeFocusId && (e.source === activeFocusId || e.target === activeFocusId);
          const isDimmed = activeFocusId && !isHighlighted;

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);

          if (e.kind === 'semantic-similarity') {
            ctx.strokeStyle = isHighlighted
              ? '#c084fc'
              : isDimmed
                ? 'rgba(168, 85, 247, 0.07)'
                : 'rgba(168, 85, 247, 0.36)';
            ctx.lineWidth = isHighlighted ? 2.2 : 1.3;
          } else if (e.kind === 'shared-tag') {
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = isHighlighted
              ? '#38bdf8'
              : 'rgba(148, 163, 184, 0.18)';
            ctx.lineWidth = 1.1;
          } else {
            ctx.strokeStyle = isHighlighted
              ? '#38bdf8'
              : isDimmed
                ? 'rgba(148, 163, 184, 0.08)'
                : 'rgba(148, 163, 184, 0.26)';
            ctx.lineWidth = isHighlighted ? 2.0 : 1.25;
          }
          ctx.stroke();

          if (isHighlighted && e.label) {
            const mx = (s.x + t.x) / 2;
            const my = (s.y + t.y) / 2;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
            ctx.fillRect(mx - 18, my - 8, 36, 16);
            ctx.fillStyle = '#e2e8f0';
            ctx.font = '600 9.5px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(e.label, mx, my);
          }
          ctx.restore();
        }

        // Draw Synaptic Particles
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          p.t = (p.t + p.speed) % 1;
          const e = p.edge;
          if (activeFocusId && e.source !== activeFocusId && e.target !== activeFocusId) {
            continue;
          }
          const px = e.sourceNode.x + (e.targetNode.x - e.sourceNode.x) * p.t;
          const py = e.sourceNode.y + (e.targetNode.y - e.sourceNode.y) * p.t;
          ctx.beginPath();
          ctx.arc(px, py, e.kind === 'semantic-similarity' ? 2.2 : 1.7, 0, Math.PI * 2);
          ctx.fillStyle = e.kind === 'semantic-similarity' ? '#e879f9' : '#38bdf8';
          ctx.fill();
        }

        // Draw Ripples
        for (let i = ripples.length - 1; i >= 0; i--) {
          const rp = ripples[i];
          rp.r += 1.4;
          rp.alpha -= 0.018;
          if (rp.alpha <= 0) {
            ripples.splice(i, 1);
            continue;
          }
          ctx.save();
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
          ctx.strokeStyle = rp.color;
          ctx.globalAlpha = rp.alpha;
          ctx.lineWidth = 2.2;
          ctx.stroke();
          ctx.restore();
        }

        // Draw Nodes
        const isSearchActive = searchScoresById.size > 0;
        for (let i = 0; i < N; i++) {
          const n = simNodes[i];
          const searchHit = n.memoryId ? searchScoresById.get(n.memoryId) : null;
          const isFocused = n.id === selectedNodeId || n.id === hoveredNodeId;
          const isNeighbor = neighborIds.has(n.id);

          let alpha = 1;
          if (isSearchActive) {
            alpha = (searchHit || n.type === 'project') ? 1 : 0.16;
          } else if (activeFocusId && !isNeighbor) {
            alpha = 0.2;
          }

          ctx.save();
          ctx.globalAlpha = alpha;

          // Breathing halo for high importance or search hit
          const pulse = Math.sin(frameTick + (n.phase || 0)) * 2.4;
          if (n.type === 'project' || (n.importance && n.importance >= 0.8) || searchHit || isFocused) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.radius + 5 + Math.max(0, pulse), 0, Math.PI * 2);
            ctx.fillStyle = searchHit ? 'rgba(56, 189, 248, 0.28)' : n.color + '28';
            ctx.fill();
          }

          // Node circle
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
          ctx.fillStyle = n.color;
          ctx.fill();

          ctx.lineWidth = isFocused ? 3 : searchHit ? 2.5 : 1.5;
          ctx.strokeStyle = isFocused ? '#ffffff' : searchHit ? '#38bdf8' : 'rgba(255,255,255,0.35)';
          ctx.stroke();

          // Inner icon or badge for project nodes
          if (n.type === 'project') {
            ctx.fillStyle = '#0f172a';
            ctx.font = '700 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(n.label.slice(0, 3).toUpperCase(), n.x, n.y);
          }

          // Node label
          if (camScale >= 0.55 || n.type === 'project' || isFocused || searchHit) {
            const labelText = n.label.length > 28 ? n.label.slice(0, 26) + '…' : n.label;
            ctx.font = (n.type === 'project' ? '700 12px ' : '500 11px ') + 'sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const textY = n.y + n.radius + 5;
            ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'light'
              ? '#0f172a'
              : '#f1f5f9';
            ctx.fillText(labelText, n.x, textY);
          }

          ctx.restore();
        }

        ctx.restore();
        requestAnimationFrame(stepAndRender);
      }
      requestAnimationFrame(stepAndRender);

      // Screen to World coordinates
      function screenToWorld(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;
        return {
          x: (sx - camX) / camScale,
          y: (sy - camY) / camScale,
        };
      }

      function findNodeAt(wx, wy) {
        for (let i = simNodes.length - 1; i >= 0; i--) {
          const n = simNodes[i];
          const dx = wx - n.x;
          const dy = wy - n.y;
          if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) {
            return n;
          }
        }
        return null;
      }

      canvas.addEventListener('mousedown', (e) => {
        const pt = screenToWorld(e.clientX, e.clientY);
        const hit = findNodeAt(pt.x, pt.y);
        if (hit) {
          draggedNode = hit;
          selectedNodeId = hit.id;
          renderInspectorForNode(hit);
        } else {
          isPanning = true;
          panStartX = e.clientX - targetCamX;
          panStartY = e.clientY - targetCamY;
        }
      });

      window.addEventListener('mousemove', (e) => {
        const pt = screenToWorld(e.clientX, e.clientY);
        if (draggedNode) {
          draggedNode.x = pt.x;
          draggedNode.y = pt.y;
          return;
        }
        if (isPanning) {
          targetCamX = e.clientX - panStartX;
          targetCamY = e.clientY - panStartY;
          return;
        }
        const hit = findNodeAt(pt.x, pt.y);
        hoveredNodeId = hit ? hit.id : null;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      });

      window.addEventListener('mouseup', () => {
        draggedNode = null;
        isPanning = false;
      });

      canvas.addEventListener('dblclick', (e) => {
        const pt = screenToWorld(e.clientX, e.clientY);
        const hit = findNodeAt(pt.x, pt.y);
        if (hit) {
          hit.pinned = !hit.pinned;
        }
      });

      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        targetCamScale = Math.min(3.2, Math.max(0.28, targetCamScale * factor));
      }, { passive: false });

      function focusCameraOnNode(node) {
        const rect = canvas.parentElement.getBoundingClientRect();
        targetCamScale = Math.max(1.15, targetCamScale);
        targetCamX = rect.width / 2 - node.x * targetCamScale;
        targetCamY = rect.height / 2 - node.y * targetCamScale;
        ripples.push({ x: node.x, y: node.y, r: node.radius, maxR: 80, alpha: 1, color: node.color });
      }

      // Inspector Rendering
      function renderOverviewInspector() {
        if (!snapshot) return;
        inspectorHeaderTitle.textContent = 'Resumen de Bóveda';
        inspectorActions.innerHTML = '';
        inspectorBody.innerHTML =
          '<div class="meta-grid">' +
            '<div class="meta-stat"><div class="meta-stat-label">Proyectos</div><div class="meta-stat-value">' + snapshot.stats.projectCount + '</div></div>' +
            '<div class="meta-stat"><div class="meta-stat-label">Recuerdos</div><div class="meta-stat-value">' + snapshot.stats.memoryCount + '</div></div>' +
            '<div class="meta-stat"><div class="meta-stat-label">Tokens</div><div class="meta-stat-value">' + snapshot.stats.totalTokens + '</div></div>' +
          '</div>' +
          '<p style="font-size:12.5px;color:var(--text-secondary);">Selecciona un nodo en el lienzo para explorar su contenido, editarlo o navegar por sus conexiones vectoriales.</p>' +
          '<div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-top:4px;">Recuerdos más recientes / importantes</div>' +
          '<div class="related-list">' +
            snapshot.memories.slice(0, 8).map(m =>
              '<div class="related-item" data-jump-mem="' + escapeHtml(m.id) + '">' +
                '<span class="related-item-title">' + escapeHtml(m.title) + '</span>' +
                '<span class="badge">' + escapeHtml(m.projectId) + '</span>' +
              '</div>'
            ).join('') +
          '</div>';

        bindJumpListeners();
      }

      function renderInspectorForNode(node) {
        if (!snapshot) return;
        if (node.type === 'project') {
          const projMems = snapshot.memories.filter(m => m.projectId === node.projectId);
          inspectorHeaderTitle.textContent = 'Nodo Proyecto';
          inspectorActions.innerHTML = '';
          inspectorBody.innerHTML =
            '<div class="node-card-title">📦 ' + escapeHtml(node.label) + '</div>' +
            '<div class="badge-row"><span class="badge">' + escapeHtml(node.subtitle || '') + '</span></div>' +
            '<div style="font-size:11.5px;color:var(--text-muted);font-family:var(--font-mono);">' + escapeHtml((node.meta && node.meta.rootPath) || '') + '</div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:6px;">Nodos aprendidos en este proyecto (' + projMems.length + ')</div>' +
            '<div class="related-list">' +
              projMems.map(m =>
                '<div class="related-item" data-jump-mem="' + escapeHtml(m.id) + '">' +
                  '<span class="related-item-title">' + escapeHtml(m.title) + '</span>' +
                  '<span class="badge">' + escapeHtml(m.category) + '</span>' +
                '</div>'
              ).join('') +
            '</div>';
          bindJumpListeners();
          return;
        }

        if (node.type !== 'memory') {
          inspectorHeaderTitle.textContent = 'Categoría';
          inspectorActions.innerHTML = '';
          inspectorBody.innerHTML = '<div class="node-card-title">' + escapeHtml(node.label) + '</div>';
          return;
        }

        const mem = snapshot.memories.find(m => m.id === node.memoryId);
        if (!mem) return;

        const related = snapshot.relatedByMemoryId[mem.id] || [];
        const searchScore = searchScoresById.get(mem.id);

        inspectorHeaderTitle.textContent = 'Recuerdo · ' + mem.category;
        inspectorActions.innerHTML =
          '<button class="btn" id="editMemBtn" style="height:26px;padding:0 8px;font-size:11px;">Editar</button>' +
          '<button class="btn btn-danger" id="deleteMemBtn" style="height:26px;padding:0 8px;font-size:11px;">Olvidar</button>';

        let scoreHtml = '';
        if (searchScore) {
          scoreHtml =
            '<div class="badge-row">' +
              '<span class="sim-pill">RRF: ' + searchScore.score.toFixed(3) + '</span>' +
              '<span class="badge">Vec: ' + Math.round(searchScore.vectorScore * 100) + '%</span>' +
              '<span class="badge">FTS5: ' + searchScore.ftsScore.toFixed(2) + '</span>' +
            '</div>';
        }

        inspectorBody.innerHTML =
          '<div class="node-card-title">' + escapeHtml(mem.title) + '</div>' +
          '<div class="badge-row">' +
            '<span class="badge" style="border-color:' + node.color + ';color:' + node.color + ';">' + escapeHtml(mem.category) + '</span>' +
            '<span class="badge">📦 ' + escapeHtml(mem.projectId) + '</span>' +
            (mem.sourceAgent ? '<span class="badge">🤖 ' + escapeHtml(mem.sourceAgent) + '</span>' : '') +
          '</div>' +
          scoreHtml +
          '<div class="meta-grid">' +
            '<div class="meta-stat"><div class="meta-stat-label">Importancia</div><div class="meta-stat-value">' + Math.round(mem.importance * 100) + '%</div></div>' +
            '<div class="meta-stat"><div class="meta-stat-label">Tokens</div><div class="meta-stat-value">' + mem.tokenCount + '</div></div>' +
            '<div class="meta-stat"><div class="meta-stat-label">Accesos</div><div class="meta-stat-value">' + mem.accessCount + '</div></div>' +
          '</div>' +
          '<div class="memory-content-box">' + escapeHtml(mem.content) + '</div>' +
          (mem.tags && mem.tags.length > 0
            ? '<div class="tag-list">' + mem.tags.map(t => '<span class="tag-pill">#' + escapeHtml(t) + '</span>').join('') + '</div>'
            : '') +
          '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:4px;">Conexiones Semánticas (' + related.length + ')</div>' +
          '<div class="related-list">' +
            (related.length === 0
              ? '<span style="font-size:12px;color:var(--text-muted);">Sin enlaces semánticos cercanos.</span>'
              : related.map(r =>
                  '<div class="related-item" data-jump-mem="' + escapeHtml(r.memoryId) + '">' +
                    '<span class="related-item-title">' + escapeHtml(r.title) + '</span>' +
                    '<span class="sim-pill">' + Math.round(r.similarity * 100) + '%</span>' +
                  '</div>'
                ).join('')) +
          '</div>';

        bindJumpListeners();

        const editBtn = document.getElementById('editMemBtn');
        if (editBtn) {
          editBtn.addEventListener('click', () => openMemoryModal(mem));
        }
        const delBtn = document.getElementById('deleteMemBtn');
        if (delBtn) {
          delBtn.addEventListener('click', async () => {
            await fetch('/api/memories/' + encodeURIComponent(mem.id), { method: 'DELETE' });
            selectedNodeId = null;
            await loadGraph();
          });
        }
      }

      function bindJumpListeners() {
        inspectorBody.querySelectorAll('[data-jump-mem]').forEach(el => {
          el.addEventListener('click', () => {
            const memId = el.getAttribute('data-jump-mem');
            const target = simNodes.find(n => n.memoryId === memId);
            if (target) {
              selectedNodeId = target.id;
              focusCameraOnNode(target);
              renderInspectorForNode(target);
            }
          });
        });
      }

      // P2P & ACL Renderer
      function renderP2pView(p2p) {
        if (!p2p || !p2pContent) return;
        const nc = p2p.nodeConfig;
        const peers = p2p.peers || [];
        const groups = p2p.groups || [];

        let html =
          '<div class="p2p-card">' +
            '<div style="font-weight:700;font-size:14px;">🖥️ Nodo Local: ' + escapeHtml(nc.nodeName) + '</div>' +
            '<div class="badge-row">' +
              '<span class="badge">Rol: ' + escapeHtml(nc.role) + '</span>' +
              '<span class="badge">' + (nc.enabled ? '🟢 Activo' : '⚪ Standalone') + '</span>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-secondary);">Puerto P2P: ' + nc.listenHost + ':' + nc.listenPort + ' · Política sin grupo: ' + escapeHtml(nc.unassignedGroupPolicy) + '</div>' +
          '</div>';

        peers.forEach(peer => {
          html +=
            '<div class="p2p-card">' +
              '<div style="font-weight:700;font-size:14px;">🔗 Peer (' + escapeHtml(peer.role) + '): ' + escapeHtml(peer.name) + '</div>' +
              '<div style="font-size:12px;font-family:var(--font-mono);color:var(--accent-primary);">' + escapeHtml(peer.url) + '</div>' +
              '<div style="font-size:11.5px;color:var(--text-secondary);">Estado: ' + escapeHtml(peer.lastStatus || 'sin sincronizar') + '</div>' +
            '</div>';
        });

        groups.forEach(g => {
          html +=
            '<div class="p2p-card">' +
              '<div style="font-weight:700;font-size:14px;">🛡️ Grupo ACL: ' + escapeHtml(g.name) + '</div>' +
              '<div class="badge-row">' +
                '<span class="badge">' + escapeHtml(g.permissions) + '</span>' +
                '<span class="badge">Miembros: ' + g.memberNodeIds.length + '</span>' +
              '</div>' +
              '<div style="font-size:12px;color:var(--text-secondary);">Proyectos: ' + escapeHtml(g.projects.join(', ')) + ' · Categorías: ' + escapeHtml(g.categories.join(', ')) + '</div>' +
            '</div>';
        });

        p2pContent.innerHTML = html;
      }

      // Filters & Search Events
      projectSelector.addEventListener('change', (e) => {
        currentProject = e.target.value;
        loadGraph();
      });

      document.querySelectorAll('#categoryFilters .cat-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#categoryFilters .cat-chip').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentCategory = btn.getAttribute('data-cat') || 'all';
          loadGraph();
        });
      });

      simSlider.addEventListener('input', (e) => {
        minSimilarity = parseFloat(e.target.value);
        simValueLabel.textContent = Math.round(minSimilarity * 100) + '%';
        loadGraph();
      });

      groupToggleBtn.addEventListener('click', () => {
        groupByCategory = !groupByCategory;
        groupToggleBtn.classList.toggle('active', groupByCategory);
        loadGraph();
      });

      p2pToggleBtn.addEventListener('click', () => {
        const isOpen = p2pPanel.classList.toggle('open');
        p2pToggleBtn.classList.toggle('active', isOpen);
      });
      document.getElementById('closeP2pBtn').addEventListener('click', () => {
        p2pPanel.classList.remove('open');
        p2pToggleBtn.classList.remove('active');
      });

      // Hybrid RRF Search
      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const q = searchInput.value.trim();
          if (!q) {
            searchScoresById.clear();
            return;
          }
          const params = new URLSearchParams({
            q,
            project: currentProject,
            category: currentCategory,
          });
          const res = await fetch('/api/search?' + params.toString());
          if (!res.ok) return;
          const data = await res.json();
          searchScoresById.clear();
          (data.memories || []).forEach(m => {
            searchScoresById.set(m.id, m);
          });
          if (data.memories && data.memories.length > 0) {
            const topMem = data.memories[0];
            const topNode = simNodes.find(n => n.memoryId === topMem.id);
            if (topNode) {
              selectedNodeId = topNode.id;
              focusCameraOnNode(topNode);
              renderInspectorForNode(topNode);
            }
          }
        }, 180);
      });

      window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          searchInput.focus();
          searchInput.select();
        }
      });

      // Modals CRUD & Analyze
      const memoryModal = document.getElementById('memoryModal');
      const memoryForm = document.getElementById('memoryForm');
      function openMemoryModal(mem) {
        document.getElementById('modalTitle').textContent = mem ? 'Editar Recuerdo' : 'Nuevo Recuerdo en memoseb';
        document.getElementById('editMemoryId').value = mem ? mem.id : '';
        document.getElementById('memProjectInput').value = mem ? mem.projectId : (currentProject !== 'all' ? currentProject : 'mindseb');
        document.getElementById('memCategoryInput').value = mem ? mem.category : 'architecture';
        document.getElementById('memTitleInput').value = mem ? mem.title : '';
        document.getElementById('memContentInput').value = mem ? mem.content : '';
        document.getElementById('memTagsInput').value = mem && mem.tags ? mem.tags.join(', ') : '';
        document.getElementById('memImportanceInput').value = mem ? mem.importance : 0.8;
        memoryModal.classList.add('open');
      }

      document.getElementById('newMemoryBtn').addEventListener('click', () => openMemoryModal(null));
      document.getElementById('cancelMemoryModalBtn').addEventListener('click', () => memoryModal.classList.remove('open'));

      memoryForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const editId = document.getElementById('editMemoryId').value;
        const payload = {
          projectId: document.getElementById('memProjectInput').value.trim(),
          category: document.getElementById('memCategoryInput').value,
          title: document.getElementById('memTitleInput').value.trim(),
          content: document.getElementById('memContentInput').value.trim(),
          tags: document.getElementById('memTagsInput').value.split(',').map(s => s.trim()).filter(Boolean),
          importance: parseFloat(document.getElementById('memImportanceInput').value) || 0.8,
        };
        const url = editId ? '/api/memories/' + encodeURIComponent(editId) : '/api/memories';
        const method = editId ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        memoryModal.classList.remove('open');
        if (res.ok) {
          const data = await res.json();
          await loadGraph(data.memory ? data.memory.id : undefined);
        }
      });

      const analyzeModal = document.getElementById('analyzeModal');
      document.getElementById('analyzeBtn').addEventListener('click', () => analyzeModal.classList.add('open'));
      document.getElementById('cancelAnalyzeModalBtn').addEventListener('click', () => analyzeModal.classList.remove('open'));
      document.getElementById('analyzeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const targetPath = document.getElementById('analyzePathInput').value.trim();
        if (!targetPath) return;
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: targetPath }),
        });
        analyzeModal.classList.remove('open');
        if (res.ok) {
          const data = await res.json();
          currentProject = data.projectId || 'all';
          await loadGraph();
        }
      });

      // Server-Sent Events (Live Updates)
      function connectSse() {
        const es = new EventSource('/api/events');
        es.onopen = () => {
          liveDot.classList.remove('disconnected');
        };
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data.type === 'vault:changed' || data.type === 'memory:created' || data.type === 'memory:updated' || data.type === 'memory:deleted') {
              loadGraph(data.memoryId);
            }
          } catch {}
        };
        es.onerror = () => {
          liveDot.classList.add('disconnected');
          liveText.textContent = 'Reconectando…';
        };
      }

      initTheme();
      loadGraph();
      connectSse();
    })();
  </script>
</body>
</html>`
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'))
      }
    })
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

export async function startUiServer(
  options?: UiServerOptions
): Promise<UiServerInstance> {
  const port = options?.port ?? 4322
  const host = options?.host ?? '127.0.0.1'
  const bridge = new VaultBridge({ dbPath: options?.dbPath })
  const sseClients = new Set<http.ServerResponse>()

  function broadcastEvent(
    type: string,
    payload?: Record<string, unknown>
  ): void {
    const msg = JSON.stringify({
      type,
      timestamp: new Date().toISOString(),
      ...(payload ?? {}),
    })
    for (const client of sseClients) {
      try {
        client.write(`data: ${msg}\n\n`)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  let watcher: VaultWatcher | null = null
  if (!options?.disableWatcher) {
    watcher = new VaultWatcher({
      bridge,
      onChange: (fingerprint) => {
        broadcastEvent('vault:changed', { fingerprint })
      },
    })
    watcher.start()
  }

  const cssPath = path.join(PACKAGE_ROOT, 'src', 'styles', 'mind.css')

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url ?? '/', `http://${host}:${port}`)
      const pathname = parsedUrl.pathname
      const method = req.method ?? 'GET'

      if (method === 'GET' && pathname === '/') {
        const html = generateMindUiHtml(options?.initialProject ?? 'all')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }

      if (method === 'GET' && pathname === '/styles/mind.css') {
        const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
        res.end(css)
        return
      }

      if (method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        res.write(
          `data: ${JSON.stringify({
            type: 'init',
            stats: bridge.getStats(),
          })}\n\n`
        )
        sseClients.add(res)
        req.on('close', () => {
          sseClients.delete(res)
        })
        return
      }

      if (method === 'GET' && pathname === '/api/graph') {
        const projectParam = parsedUrl.searchParams.get('project') ?? undefined
        const catParam = parsedUrl.searchParams.get('category') ?? undefined
        const minSimParam = Number(
          parsedUrl.searchParams.get('minSimilarity') ?? '0.38'
        )
        const groupParam =
          parsedUrl.searchParams.get('groupByCategory') === 'true'

        const category: MemoryCategory | undefined =
          catParam && isMemoryCategory(catParam) ? catParam : undefined

        const snapshot = buildMindGraph(bridge, {
          projectId:
            projectParam && projectParam !== 'all' ? projectParam : undefined,
          category,
          minSimilarity: Number.isNaN(minSimParam) ? 0.38 : minSimParam,
          groupByCategory: groupParam,
        })
        sendJson(res, 200, snapshot)
        return
      }

      if (method === 'GET' && pathname === '/api/search') {
        const q = parsedUrl.searchParams.get('q') ?? ''
        const projectParam = parsedUrl.searchParams.get('project') ?? undefined
        const catParam = parsedUrl.searchParams.get('category') ?? undefined
        const maxTokens = Number(
          parsedUrl.searchParams.get('maxTokens') ?? '4000'
        )

        const category: MemoryCategory | undefined =
          catParam && isMemoryCategory(catParam) ? catParam : undefined

        const result = bridge.searchMemories(q, {
          projectId:
            projectParam && projectParam !== 'all' ? projectParam : undefined,
          category,
          maxTokens: Number.isNaN(maxTokens) ? 4000 : maxTokens,
        })
        sendJson(res, 200, result)
        return
      }

      if (method === 'POST' && pathname === '/api/memories') {
        const body = await readJsonBody(req)
        const content = typeof body.content === 'string' ? body.content : ''
        if (!content.trim()) {
          sendJson(res, 400, { error: 'Memory content is required.' })
          return
        }
        const category =
          typeof body.category === 'string' && isMemoryCategory(body.category)
            ? body.category
            : 'domain'
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === 'string')
          : []

        const outcome = bridge.createMemory({
          projectId:
            typeof body.projectId === 'string' ? body.projectId : undefined,
          projectName:
            typeof body.projectName === 'string' ? body.projectName : undefined,
          rootPath:
            typeof body.rootPath === 'string' ? body.rootPath : undefined,
          category,
          title: typeof body.title === 'string' ? body.title : undefined,
          content,
          tags,
          importance:
            typeof body.importance === 'number' ? body.importance : undefined,
        })

        broadcastEvent('memory:created', { memoryId: outcome.memory.id })
        sendJson(res, 201, outcome)
        return
      }

      if (
        (method === 'PUT' || method === 'DELETE') &&
        pathname.startsWith('/api/memories/')
      ) {
        const id = decodeURIComponent(pathname.slice('/api/memories/'.length))
        if (!id) {
          sendJson(res, 400, { error: 'Memory ID is required.' })
          return
        }

        if (method === 'DELETE') {
          const deleted = bridge.deleteMemory(id)
          if (!deleted) {
            sendJson(res, 404, { error: 'Memory not found.' })
            return
          }
          broadcastEvent('memory:deleted', { memoryId: id })
          sendJson(res, 200, { deleted: true, id })
          return
        }

        const body = await readJsonBody(req)
        const category =
          typeof body.category === 'string' && isMemoryCategory(body.category)
            ? body.category
            : undefined
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === 'string')
          : undefined

        const updated = bridge.updateMemory(id, {
          title: typeof body.title === 'string' ? body.title : undefined,
          content: typeof body.content === 'string' ? body.content : undefined,
          category,
          tags,
          importance:
            typeof body.importance === 'number' ? body.importance : undefined,
          projectId:
            typeof body.projectId === 'string' ? body.projectId : undefined,
        })
        if (!updated) {
          sendJson(res, 404, { error: 'Memory not found.' })
          return
        }
        broadcastEvent('memory:updated', { memoryId: updated.id })
        sendJson(res, 200, { memory: updated })
        return
      }

      if (method === 'POST' && pathname === '/api/analyze') {
        const body = await readJsonBody(req)
        const targetPath = typeof body.path === 'string' ? body.path.trim() : ''
        if (!targetPath) {
          sendJson(res, 400, { error: 'Repository path is required.' })
          return
        }
        const report = bridge.analyzeProjectDirectory(targetPath)
        broadcastEvent('vault:changed', { projectId: report.projectId })
        sendJson(res, 200, report)
        return
      }

      if (method === 'GET' && pathname === '/api/p2p') {
        sendJson(res, 200, {
          nodeConfig: bridge.getNodeConfig(),
          peers: bridge.listPeers(),
          groups: bridge.listGroups(),
        })
        return
      }

      sendJson(res, 404, { error: 'Not Found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port
  const url = `http://${host}:${actualPort}`

  if (options?.openWindow) {
    launchStandaloneDesktopWindow(url, false)
  } else if (options?.openBrowser) {
    launchStandaloneDesktopWindow(url, true)
  }

  return {
    server,
    port: actualPort,
    url,
    bridge,
    broadcastEvent,
    getSnapshot: (projectId?: string, category?: MemoryCategory) =>
      buildMindGraph(bridge, { projectId, category }),
    close: async () => {
      if (watcher) watcher.stop()
      for (const client of sseClients) {
        try {
          client.end()
        } catch {}
      }
      sseClients.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      bridge.close()
    },
  }
}
