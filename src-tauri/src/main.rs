#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Thin native shell: spawns the Node SEA sidecar (`memosebui sidecar`), waits for its
//! `{"event":"ready","url":...}` line and points the window at that loopback URL. All viewer
//! logic lives in the TypeScript server, so the CLI and the desktop app never diverge.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_BIN: &str = "memosebui-server";
const READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    exiting: AtomicBool,
}

/// Startup is a one-way state machine: whichever of ready / terminated / timeout happens first
/// wins, so a late event can never overwrite the outcome the user is already looking at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Phase {
    Waiting = 0,
    Ready = 1,
    Failed = 2,
}

#[derive(Default)]
struct Startup {
    phase: AtomicU8,
    server: OnceLock<Url>,
}

impl Startup {
    fn advance(&self, to: Phase) -> bool {
        self.phase
            .compare_exchange(Phase::Waiting as u8, to as u8, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

#[derive(Deserialize)]
struct ReadyEvent {
    event: String,
    url: String,
}

/// Origin Tauri 2 serves bundled assets from (`frontendDist`). Derived statically because
/// `WebviewWindow::url()` right after `build()` is unreliable on Windows and macOS.
fn shell_origin() -> Url {
    let origin = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(origin).expect("static shell origin is a valid URL")
}

fn parse_ready(line: &[u8]) -> Option<Url> {
    let ready: ReadyEvent = serde_json::from_slice(line.trim_ascii()).ok()?;
    if ready.event != "ready" {
        return None;
    }
    let url = Url::parse(&ready.url).ok()?;
    // Only ever load the loopback server we spawned; never a remote origin from stdout.
    let loopback = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    loopback.then_some(url)
}

// `Url::origin()` is opaque (never equal) for custom schemes like `tauri://`, so compare by parts.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_allowed(url: &Url, shell: &Url, server: Option<&Url>) -> bool {
    same_origin(url, shell) || server.is_some_and(|server| same_origin(url, server))
}

fn is_external_link(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn error_page(message: &str) -> Url {
    let mut page = shell_origin().join("index.html").expect("static loading page path");
    page.query_pairs_mut().append_pair("error", message);
    page
}

fn fail_startup(app: &AppHandle, window: &WebviewWindow, startup: &Startup, message: &str) {
    if !startup.advance(Phase::Failed) {
        return;
    }
    eprintln!("[memosebui-desktop] startup failed: {message}");
    let _ = window.navigate(error_page(message));
    kill_sidecar(app);
}

fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.exiting.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().ok().and_then(|mut guard| guard.take()) {
        let _ = child.kill();
    }
}

fn start_sidecar(app: &AppHandle, window: WebviewWindow, startup: Arc<Startup>) {
    let spawned = app
        .shell()
        .sidecar(SIDECAR_BIN)
        .and_then(|command| command.args(["sidecar"]).spawn());

    let (mut events, child) = match spawned {
        Ok(pair) => pair,
        Err(err) => {
            fail_startup(app, &window, &startup, &format!("No se pudo lanzar {SIDECAR_BIN}: {err}"));
            return;
        }
    };
    if let Ok(mut guard) = app.state::<SidecarState>().child.lock() {
        *guard = Some(child);
    }

    {
        let app = app.clone();
        let window = window.clone();
        let startup = startup.clone();
        std::thread::spawn(move || {
            std::thread::sleep(READY_TIMEOUT);
            let secs = READY_TIMEOUT.as_secs();
            fail_startup(&app, &window, &startup, &format!("El servidor no respondió en {secs} s."));
        });
    }

    let app = app.clone();
    // Drain every event, even after `ready`, so the sidecar never blocks on a full stdout pipe.
    tauri::async_runtime::spawn(async move {
        let mut stderr_tail: Vec<String> = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let Some(url) = parse_ready(&line) else { continue };
                    if startup.advance(Phase::Ready) {
                        let _ = startup.server.set(url.clone());
                        if let Err(err) = window.navigate(url) {
                            eprintln!("[memosebui-desktop] navigation to sidecar failed: {err}");
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    eprintln!("[memosebui-server] {line}");
                    stderr_tail.push(line);
                    if stderr_tail.len() > 8 {
                        stderr_tail.remove(0);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if !app.state::<SidecarState>().exiting.load(Ordering::SeqCst) {
                        let code = payload.code.map_or_else(|| "señal".to_string(), |c| c.to_string());
                        let message =
                            format!("El servidor se detuvo (código {code}).\n{}", stderr_tail.join("\n"));
                        // A crash after `ready` must still surface, so this overrides any phase.
                        startup.phase.store(Phase::Failed as u8, Ordering::SeqCst);
                        eprintln!("[memosebui-desktop] sidecar exited with code {code}");
                        let _ = window.navigate(error_page(&message));
                    }
                    break;
                }
                CommandEvent::Error(err) => eprintln!("[memosebui-desktop] sidecar event error: {err}"),
                _ => {}
            }
        }
    });
}

fn main() {
    // WebKitGTK's DMA-BUF renderer aborts with "Error 71 (Protocol error)" on Wayland with NVIDIA
    // drivers (reproduced on Hyprland + RTX 2060). Must run before any thread is spawned.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // The default init() injects a click handler into every page, including the remote viewer,
        // that swallows target=_blank clicks and calls an IPC command the viewer has no permission
        // for. External links already go through on_navigation/on_new_window below.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(SidecarState::default())
        .setup(|app| {
            let startup = Arc::new(Startup::default());
            let shell = shell_origin();

            let nav_opener = app.handle().clone();
            let nav_startup = startup.clone();
            let popup_opener = app.handle().clone();

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("memosebui")
                .inner_size(1360.0, 860.0)
                .min_inner_size(720.0, 480.0)
                .on_navigation(move |url| {
                    if is_allowed(url, &shell, nav_startup.server.get()) {
                        return true;
                    }
                    if is_external_link(url) {
                        let _ = nav_opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                // Plan links use target="_blank", which bypasses on_navigation entirely.
                .on_new_window(move |url, _features| {
                    if is_external_link(&url) {
                        let _ = popup_opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;

            start_sidecar(app.handle(), window, startup);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the memosebui desktop app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            kill_sidecar(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_ready_line() {
        let url = parse_ready(br#"{"event":"ready","url":"http://127.0.0.1:41234","port":41234,"pid":1}"#);
        assert_eq!(url.unwrap().as_str(), "http://127.0.0.1:41234/");
        let crlf = parse_ready(b"{\"event\":\"ready\",\"url\":\"http://127.0.0.1:5\"}\r\n");
        assert!(crlf.is_some(), "trailing CRLF from Windows pipes is tolerated");
    }

    #[test]
    fn rejects_non_loopback_or_malformed_lines() {
        for line in [
            br#"{"event":"ready","url":"https://evil.example"}"#.as_slice(),
            br#"{"event":"ready","url":"http://0.0.0.0:80"}"#,
            br#"{"event":"ready","url":"http://127.0.0.1.evil.com:80"}"#,
            br#"{"event":"ready","url":"http://evil.com@127.0.0.2:80"}"#,
            br#"{"event":"ready","url":"http://[::1]:80"}"#,
            br#"{"event":"ready","url":"http://127.0.0.1:99999"}"#,
            br#"{"event":"log","url":"http://127.0.0.1:1"}"#,
            b"plain log line",
        ] {
            assert!(parse_ready(line).is_none(), "{}", String::from_utf8_lossy(line));
        }
    }

    #[test]
    fn navigation_is_limited_to_shell_and_server_origins() {
        let shell = shell_origin();
        let server = Url::parse("http://127.0.0.1:5555/").unwrap();
        let error = error_page("boom");

        assert!(is_allowed(&error, &shell, None), "error page is always reachable");
        assert!(!is_allowed(&server, &shell, None), "server is unknown until ready");
        assert!(is_allowed(&Url::parse("http://127.0.0.1:5555/api/graph").unwrap(), &shell, Some(&server)));
        assert!(!is_allowed(&Url::parse("http://127.0.0.1:6666/").unwrap(), &shell, Some(&server)));
        assert!(!is_allowed(&Url::parse("https://github.com/").unwrap(), &shell, Some(&server)));
        assert!(!is_allowed(&Url::parse("file:///etc/passwd").unwrap(), &shell, Some(&server)));
    }

    #[test]
    fn only_web_and_mail_links_leave_the_app() {
        assert!(is_external_link(&Url::parse("https://github.com/").unwrap()));
        assert!(is_external_link(&Url::parse("mailto:a@b.c").unwrap()));
        assert!(!is_external_link(&Url::parse("file:///etc/passwd").unwrap()));
        assert!(!is_external_link(&Url::parse("javascript:alert(1)").unwrap()));
    }

    #[test]
    fn error_page_encodes_the_message() {
        let page = error_page("código 1\n& <x>");
        assert!(same_origin(&page, &shell_origin()));
        assert_eq!(page.path(), "/index.html");
        let (key, value) = page.query_pairs().next().unwrap();
        assert_eq!((key.as_ref(), value.as_ref()), ("error", "código 1\n& <x>"));
    }

    #[test]
    fn startup_phase_is_decided_once() {
        let startup = Startup::default();
        assert!(startup.advance(Phase::Ready));
        assert!(!startup.advance(Phase::Failed), "a late timeout cannot override ready");

        let startup = Startup::default();
        assert!(startup.advance(Phase::Failed));
        assert!(!startup.advance(Phase::Ready), "a late ready cannot hide the error");
    }
}
