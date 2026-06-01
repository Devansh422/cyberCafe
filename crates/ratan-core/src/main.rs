//! `ratan-server` — standalone dev/test entry point for the Rust backend.
//! Reads config from the environment (mirroring the old `backend/.env`) and
//! serves the same `/api` the Express backend did on port 5000.

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let config = ratan_core::Config::from_env();
    ratan_core::serve(config).await
}
