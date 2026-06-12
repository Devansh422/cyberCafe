//! Ratan backend core — a Rust port of the Express backend in `backend/`.
//!
//! Used two ways:
//!   * `ratan-server` (the `[[bin]]`) runs it standalone for dev/testing against
//!     the existing Next.js frontend.
//!   * The Tauri app (Phase 4) calls [`serve`] on a background task so the whole
//!     backend ships inside one desktop executable.

pub mod cleanup;
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

    // Background services.
    cleanup::spawn(state.clone());
    if state.config.whatsapp_enabled {
        let s = state.clone();
        tokio::spawn(async move {
            if let Err(e) = s.whatsapp.start().await {
                tracing::warn!("[whatsapp] start error: {e}");
            }
        });
    }

    let app = routes::router(state.clone());
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("[ratan-core] listening on http://localhost:{port}");
    tracing::info!("[ratan-core] db: {}", state.config.db_path.display());
    tracing::info!("[ratan-core] media root: {}", state.config.media_root.display());
    axum::serve(listener, app).await?;
    Ok(())
}
