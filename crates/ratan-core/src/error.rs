//! Unified error type that renders as the same JSON the Express backend sent:
//! `{ "error": "<message>" }` with an appropriate HTTP status.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not_found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn bad(msg: impl Into<String>) -> Self {
        AppError::BadRequest(msg.into())
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError::Internal(msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, body) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, json!({ "error": "not_found" })),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, json!({ "error": m })),
            AppError::Conflict(m) => (StatusCode::CONFLICT, json!({ "error": m })),
            AppError::Internal(m) => {
                tracing::error!("[error] {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": m }))
            }
        };
        (status, Json(body)).into_response()
    }
}

// Anything that fails with a generic error becomes a 500, mirroring the Express
// catch-all error middleware.
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
