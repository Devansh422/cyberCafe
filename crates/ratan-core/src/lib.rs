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
/// first run / after a component bump) and start WhatsApp. Runs on a background
/// task so the API is available immediately and the UI can show download
/// progress via `/api/system/components`. In dev (`RATAN_COMPONENTS_DIR` unset)
/// there's nothing to fetch and it goes straight to starting WhatsApp.
///
/// The work is split so the app feels fast and WhatsApp is robust:
///   * **Essential components** (ONNX models, SumatraPDF) gate the UI via the
///     setup screen. Per-file `.sha256` markers mean only the specs whose marker
///     is absent/stale are fetched — so on a post-update boot these are usually
///     all present and the app opens with no setup screen at all.
///   * **The WhatsApp sidecar** is rebuilt every release, so its hash changes on
///     every update. It is therefore fetched *in the background* and never gates
///     the UI; WhatsApp starts the moment its sidecar is present — independent of
///     (and never blocked or aborted by) the heavy model downloads.
pub fn spawn_bootstrap(state: SharedState) {
    tokio::spawn(async move {
        let Some(dir) = state.config.components_dir.clone() else {
            // Dev run — nothing to fetch.
            state.components.set_ready();
            start_whatsapp(&state).await;
            return;
        };

        let specs = components::manifest();
        let needs_work = components::specs_needing_work(&dir, &specs);

        // Split off the WhatsApp sidecar (matched by its destination filename) so
        // it doesn't sit behind the model downloads in the UI-gating phase.
        let sidecar_file = state
            .config
            .sidecar_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned());
        let (wa_work, rest_work): (Vec<_>, Vec<_>) = needs_work
            .into_iter()
            .partition(|s| Some(s.file.as_str()) == sidecar_file.as_deref());

        // Phase 1: essential components gate the UI. When `rest_work` is empty
        // (the common case on an update where only the sidecar changed), this is
        // ready instantly and the setup screen never appears.
        if rest_work.is_empty() {
            state.components.set_ready();
        } else {
            state.components.reset(&rest_work);
            match components::ensure_all(&dir, &rest_work, &state.components).await {
                Ok(()) => state.components.set_ready(),
                Err(e) => {
                    // The UI shows a retry screen, but WhatsApp is independent of
                    // these, so we still bring it up below.
                    tracing::error!("[components] download failed: {e}");
                    state.components.set_error(e.to_string());
                }
            }
        }

        // Phase 2: WhatsApp sidecar in the background, then start WhatsApp as soon
        // as it's present. Progress for it is intentionally not shown (the gate is
        // already past), so a rebuilt-sidecar re-download never blocks the app.
        if !wa_work.is_empty() {
            if let Err(e) = components::ensure_all(&dir, &wa_work, &state.components).await {
                tracing::error!("[components] WhatsApp sidecar fetch failed: {e}");
            }
        }
        start_whatsapp(&state).await;
    });
}

/// Start the WhatsApp client (no-op when WhatsApp is disabled).
async fn start_whatsapp(state: &SharedState) {
    if state.config.whatsapp_enabled {
        if let Err(e) = state.whatsapp.start().await {
            tracing::warn!("[whatsapp] start error: {e}");
        }
    }
}
