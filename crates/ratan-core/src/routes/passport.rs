//! `/api/passport/*` — ports `backend/src/routes/passport.js`.

use axum::body::Bytes;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::passport::{self, SheetItem};
use crate::routes::parse_body;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/status", get(status))
        .route("/prepare", post(prepare))
        .route("/prepare-job", post(prepare_job))
        .route("/prepared/:id", get(prepared))
        .route("/sheet", post(sheet))
}

async fn status(State(st): State<SharedState>) -> Json<passport::PassportStatus> {
    Json(passport::status(&st.config))
}

fn with_preview(result: impl serde::Serialize, id: &str) -> AppResult<Response> {
    let mut v = serde_json::to_value(result).map_err(|e| AppError::internal(e.to_string()))?;
    if let Value::Object(map) = &mut v {
        map.insert("previewUrl".into(), json!(format!("/api/passport/prepared/{id}")));
    }
    Ok((StatusCode::CREATED, Json(v)).into_response())
}

async fn prepare(State(st): State<SharedState>, mut multipart: Multipart) -> AppResult<Response> {
    let mut file: Option<Vec<u8>> = None;
    let mut bg: Option<String> = None;
    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        match field.name().unwrap_or("") {
            "file" => file = Some(field.bytes().await.map_err(|e| AppError::bad(e.to_string()))?.to_vec()),
            "bg" => bg = field.text().await.ok(),
            _ => {
                let _ = field.bytes().await;
            }
        }
    }
    let Some(buffer) = file else { return Err(AppError::bad("file required")) };
    let result = passport::prepare(&st, buffer, bg).await?;
    let id = result.id.clone();
    with_preview(result, &id)
}

#[derive(Debug, Deserialize, Default)]
struct PrepareJobBody {
    #[serde(rename = "jobId")]
    job_id: Option<i64>,
    bg: Option<String>,
}

async fn prepare_job(State(st): State<SharedState>, body: Bytes) -> AppResult<Response> {
    let b: PrepareJobBody = parse_body(&body);
    let Some(job_id) = b.job_id else { return Err(AppError::bad("jobId required")) };
    let result = passport::prepare_from_job(&st, job_id, b.bg).await?;
    let id = result.id.clone();
    with_preview(result, &id)
}

async fn prepared(State(st): State<SharedState>, Path(id): Path<String>) -> Response {
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let file = passport::prepared_path(&st.config, &clean);
    if !file.exists() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(&file).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/png")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Debug, Deserialize, Default)]
struct SheetBody {
    #[serde(default)]
    items: Vec<SheetItem>,
    bg: Option<String>,
}

async fn sheet(State(st): State<SharedState>, body: Bytes) -> AppResult<Response> {
    let b: SheetBody = parse_body(&body);
    if b.items.is_empty() {
        return Err(AppError::bad("add at least one photo"));
    }
    let job = passport::create_sheet(&st, b.items, b.bg).await?;
    Ok((StatusCode::CREATED, Json(job)).into_response())
}
