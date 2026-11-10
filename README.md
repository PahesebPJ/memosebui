# 🧠 `mindseb` — Visor Neuronal e Interfaz de Escritorio para `memoseb`

Interfaz gráfica de escritorio multiplataforma (**Linux, macOS y Windows**) ultraligera para explorar, buscar y gestionar visualmente los nodos de conocimiento almacenados en [`memoseb`](https://github.com/PahesebPJ/memoseb) dentro del ecosistema `*seb` ([`hubseb`](https://github.com/PahesebPJ/hubseb), [`crewseb`](https://github.com/PahesebPJ/crewseb), [`deckseb`](https://github.com/PahesebPJ/deckseb)).

## ✨ Características Principales

1. **Grafo de Física Force-Directed a 60 FPS (Canvas 2D HiDPI):**
   - Nodos gravitacionales por **Proyecto**, anillos opcionales por **Categoría** (`architecture`, `convention`, `bugfix`, `decision`, `domain`) y nodos satélite por **Recuerdo** escalados según su importancia y accesos.
   - **Enlaces Semánticos Reales:** Calcula la similitud coseno entre vectores `Float32Array` de `memory_vectors` para enlazar aprendizajes relacionados dentro del mismo proyecto o entre proyectos distintos.
   - **Animaciones Sinápticas:** Fotones animados viajando por las aristas, halos respiratorios para recuerdos críticos y ondas expansivas en tiempo real (vía SSE) cuando un agente aprende algo nuevo.
2. **Buscador Híbrido RRF en Vivo (`Cmd/Ctrl + K`):**
   - Combina búsqueda léxica `SQLite FTS5` (BM25) + similitud vectorial coseno + Reciprocal Rank Fusion para iluminar y enfocar los nodos relevantes al instante.
3. **Gestión CRUD e Indexación (`memoseb analyze`):**
   - Crea, edita u olvida (`forget` con registro de tombstones) recuerdos directamente desde el inspector lateral o dispara el análisis de un repositorio completo.
4. **Topología P2P y Grupos ACL:**
   - Visualiza el estado del nodo local (`standalone`, `parent`, `child`), los peers sincronizados y las reglas de permisos por grupo ACL.

## 🚀 Uso Rápido

```bash
# Registrar mindseb en la topología de hubseb y arrancar el daemon (:4322)
mindseb setup

# Abrir la ventana dedicada de escritorio con el grafo neuronal
mindseb ui

# Consultar estado y conexión con vault.sqlite
mindseb status
```
