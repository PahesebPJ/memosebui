# 🧠 `memosebui` — Visor Neuronal e Interfaz de Escritorio para `memoseb`

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
# Registrar memosebui en la topología de hubseb y arrancar el daemon (:4322)
memosebui setup

# Abrir la ventana dedicada de escritorio con el grafo neuronal
memosebui ui

# Consultar estado y conexión con vault.sqlite
memosebui status
```

## 🖥️ App de Escritorio Nativa (Tauri)

Instalables para Linux (`.deb`, `.rpm`, `.AppImage`), macOS (`.dmg`) y Windows (`.msi`, `-setup.exe`) que **no necesitan Node instalado**. La app es un envoltorio Tauri 2 que lanza el propio CLI, empaquetado como ejecutable Node SEA, en modo `memosebui sidecar` (puerto efímero en `127.0.0.1`), y muestra el mismo visor en una ventana nativa. Usa la misma bóveda que `memoseb` (`MEMOSEB_DB_PATH` o el directorio de datos de la plataforma). Al cerrar la ventana, el servidor se detiene.

Los instaladores se adjuntan a cada GitHub Release.

> [!WARNING]
> Los binarios aún no están firmados: macOS (Gatekeeper) y Windows (SmartScreen) mostrarán un aviso de app no verificada la primera vez.

Compilación local (requiere Rust stable y, en Linux, `webkit2gtk-4.1` y `libayatana-appindicator`):

```sh
npm ci
npm run tauri build   # ejecuta npm run build:sidecar y genera los instalables en src-tauri/target/release/bundle/
```

Verificación del envoltorio (el sidecar debe estar compilado antes de cualquier comando `cargo`):

```sh
npm run build:sidecar
node scripts/smoke-sidecar.mjs src-tauri/binaries/memosebui-server-<target-triple>
(cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)
```

## 🔒 Seguridad de la API local

El daemon escucha solo en `127.0.0.1:4322` y atiende únicamente al propio visor (mismo origen) y al CLI. Así, ninguna web abierta en el navegador puede leer la bóveda ni inyectar memorias:

- Se rechazan con `403` las peticiones con un `Host` ajeno (DNS rebinding), con un `Origin` de otro sitio o `null`, o con `Sec-Fetch-Site: cross-site`/`same-site`.
  La única excepción es abrir el visor (`GET /`) desde un enlace de otra web; la API sigue rechazando esas peticiones.
- No se envían cabeceras CORS y los preflight (`OPTIONS`) devuelven `405`.
- `POST` y `PUT` exigen `Content-Type: application/json` (si no, `415`) y un cuerpo de 1 MB como máximo (si no, `413`).

Si integras otra herramienta con la API, llámala desde un proceso local (sin cabecera `Origin`) y envía JSON.
