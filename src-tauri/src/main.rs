// Ratan desktop app — Tauri v2 shell that runs the Rust backend (ratan-core) on
// a background task inside the app process, serving the same `/api` the bundled
// Next.js UI calls. The WhatsApp sidecar is spawned/supervised by ratan-core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsStr;
use std::path::PathBuf;

use tauri::Manager;

/// Set an env var only if it isn't already set, so external overrides (and the
/// dev `ratan-server`) win while the packaged app gets sensible defaults.
fn set_default(key: &str, val: impl AsRef<OsStr>) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, val);
    }
}

/// Append panics to `%LOCALAPPDATA%\com.ratan.app\logs\panic.log` so a crash on
/// a user's machine leaves a readable message instead of a silent
/// STATUS_ILLEGAL_INSTRUCTION. Installed first thing in `main` — before the
/// Tauri `build()` — so even WebView2 / startup failures are captured. (Release
/// builds run with `windows_subsystem = "windows"`, so there is no console for
/// the default hook to print to; the log file is the only record.)
fn install_panic_logger() {
    let dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.ratan.app")
        .join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("panic.log");
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[unix:{secs}] {info}");
        }
        prev(info);
    }));
}

fn main() {
    install_panic_logger();
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Persist under %LOCALAPPDATA%\com.ratan.app\ in the packaged app.
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            set_default("MEDIA_ROOT", data_dir.join("media-center"));
            set_default("DB_PATH", data_dir.join("data").join("ratan.db"));
            set_default("WA_SESSION_DIR", data_dir.join("wwebjs_auth"));

            // Bundled resources (models / SumatraPDF / sidecar). When running
            // unbundled (cargo run / cargo build exe), these won't exist next to
            // the binary, so we leave them unset and let Config::from_env
            // discover them from the project tree.
            if let Ok(rd) = app.path().resource_dir() {
                let modnet = rd.join("models").join("modnet.onnx");
                if modnet.exists() {
                    set_default("MODNET_ONNX", &modnet);
                }
                let face = rd.join("models").join("ultraface-RFB-320.onnx");
                if face.exists() {
                    set_default("FACE_ONNX", &face);
                }
                let sidecar = rd.join("whatsapp-sidecar.exe");
                if sidecar.exists() {
                    set_default("WA_SIDECAR_PATH", &sidecar);
                }
                if rd.join("SumatraPDF.exe").exists() {
                    set_default("RATAN_RESOURCE_DIR", &rd);
                }
                // Point `ort` (load-dynamic) at the bundled Microsoft ONNX
                // Runtime DLL. Read lazily on the first passport inference, so
                // setting it here in `setup` is early enough.
                let ort_dll = rd.join("onnxruntime.dll");
                if ort_dll.exists() {
                    set_default("ORT_DYLIB_PATH", &ort_dll);
                }
            }

            let config = ratan_core::Config::from_env();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ratan_core::serve(config).await {
                    eprintln!("[ratan-core] fatal: {e}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ratan")
        .run(|_app, event| {
            // On exit, make sure the WhatsApp sidecar (and the Chromium it
            // spawned) is gone. A leftover whatsapp-sidecar.exe keeps the file
            // locked, which breaks both reinstalls and the in-place auto-update
            // ("Error opening file for writing … whatsapp-sidecar.exe").
            if let tauri::RunEvent::Exit = event {
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    let _ = std::process::Command::new("taskkill")
                        .args(["/IM", "whatsapp-sidecar.exe", "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                }
            }
        });
}
