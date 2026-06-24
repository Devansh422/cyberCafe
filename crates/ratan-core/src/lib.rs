//! Ratan backend core — a Rust port of the Express backend in `backend/`.
//!
//! Used two ways:
//!   * `ratan-server` (the `[[bin]]`) runs it standalone for dev/testing against
//!     the existing Next.js frontend.
//!   * The Tauri app (Phase 4) calls [`serve`] on a background task so the whole
//!     backend ships inside one desktop executable.

pub mod cleanup;
pub mod components;
pub mod config;
pub mod db;
pub mod diagnostics;
pub mod error;
pub mod imaging;
pub mod media;
pub mod paper;
pub mod passport;
pub mod pdf;
pub mod print;
pub mod proc;
pub mod processing;
pub mod routes;
pub mod state;
pub mod whatsapp;

pub use config::Config;
pub use state::{AppState, SharedState};

/// Build the app state, start background services, and serve the HTTP API on
/// `127.0.0.1:<port>` until the process exits.
pub async fn serve(config: Config) -> anyhow::Result<()> {
    let port = config.port;
    let state = AppState::new(config)?;

    // Background services. The HTTP server comes up immediately; heavy runtime
    // components (models / onnxruntime.dll / SumatraPDF / sidecar) download in the
    // background, and WhatsApp only starts once they're present.
    cleanup::spawn(state.clone());
    spawn_bootstrap(state.clone());

    let app = routes::router(state.clone());
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("[ratan-core] listening on http://localhost:{port}");
    tracing::info!("[ratan-core] db: {}", state.config.db_path.display());
    tracing::info!("[ratan-core] media root: {}", state.config.media_root.display());
    axum::serve(listener, app).await?;
    Ok(())
}

/// Ensure the externalized runtime components are present (downloading them on
/// first run / after a component bump), then start WhatsApp. Runs on a background
/// task so the API is available immediately and the UI can show download
/// progress via `/api/system/components`. In dev (`RATAN_COMPONENTS_DIR` unset)
/// there's nothing to fetch and it goes straight to starting WhatsApp.
///
/// Per-file `.sha256` markers let us determine which components need work before
/// touching any large file. Only components whose marker is absent or stale are
/// shown in the progress UI — on a post-update boot where only the sidecar
/// changed, the UI shows just the sidecar's size, not the full 229 MB.
pub fn spawn_bootstrap(state: SharedState) {
    tokio::spawn(async move {
        if let Some(dir) = state.config.components_dir.clone() {
            let specs = components::manifest();

            // Quick pre-check using tiny per-file markers — never reads large files.
            // Only the specs whose marker is absent or stale need verification or download.
            let needs_work = components::specs_needing_work(&dir, &specs);

            if needs_work.is_empty() {
                // All markers valid → ready immediately; the setup UI never shows.
                state.components.set_ready();
            } else {
                // Reset the progress state with ONLY the specs that need work so
                // the UI total shows (e.g.) "7 MB" not "229 MB" after a patch update.
                state.components.reset(&needs_work);
                match components::ensure_all(&dir, &specs, &state.components).await {
                    Ok(()) => state.components.set_ready(),
                    Err(e) => {
                        tracing::error!("[components] download failed: {e}");
                        state.components.set_error(e.to_string());
                        return; // leave WhatsApp/passport gated; the UI offers a retry
                    }
                }
            }
        } else {
            state.components.set_ready();
        }

        if state.config.whatsapp_enabled {
            if let Err(e) = state.whatsapp.start().await {
                tracing::warn!("[whatsapp] start error: {e}");
            }
        }
    });
}
