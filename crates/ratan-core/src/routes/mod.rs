//! axum router assembling the `/api/*` surface at parity with the Express app.

pub mod jobs;
pub mod passport;
pub mod system;

use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::state::SharedState;

/// 50 MB matches multer's job-upload limit (passport's 25 MB is well under it).
const BODY_LIMIT: usize = 50 * 1024 * 1024;

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .nest("/api/jobs", jobs::router())
        .nest("/api/system", system::router())
        .nest("/api/passport", passport::router())
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        // Local desktop app: the only callers are the bundled UI and the dev
        // frontend, so a permissive CORS policy is appropriate and avoids origin
        // mismatches between dev (localhost:4500) and the Tauri webview.
        .layer(CorsLayer::very_permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "time": chrono::Utc::now().to_rfc3339() }))
}

/// Parse a JSON request body, tolerating an empty/invalid body by falling back
/// to `T::default()` — matching Express's `express.json()` which leaves
/// `req.body = {}` when no body is sent (several POSTs send no body).
pub fn parse_body<T: serde::de::DeserializeOwned + Default>(bytes: &axum::body::Bytes) -> T {
    if bytes.is_empty() {
        return T::default();
    }
    serde_json::from_slice(bytes).unwrap_or_default()
}
