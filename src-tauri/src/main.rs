// Ratan desktop app — Tauri v2 shell that runs the Rust backend (ratan-core) on
// a background task inside the app process, serving the same `/api` the bundled
// Next.js UI calls. The WhatsApp sidecar is spawned/supervised by ratan-core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsStr;

use tauri::Manager;

/// Set an env var only if it isn't already set, so external overrides (and the
/// dev `ratan-server`) win while the packaged app gets sensible defaults.
fn set_default(key: &str, val: impl AsRef<OsStr>) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, val);
    }
}

fn main() {
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
            }

            let config = ratan_core::Config::from_env();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ratan_core::serve(config).await {
                    eprintln!("[ratan-core] fatal: {e}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Ratan");
}
