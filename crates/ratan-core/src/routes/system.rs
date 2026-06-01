//! `/api/system/*` — ports `backend/src/routes/system.js`.

use axum::body::Bytes;
use axum::extract::{Multipart, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{activity, jobs};
use crate::error::{AppError, AppResult};
use crate::media::{self, Incoming};
use crate::routes::parse_body;
use crate::whatsapp::WaState;
use crate::{diagnostics, print, processing};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/status", get(status))
        .route("/whatsapp/qr", get(wa_qr))
        .route("/whatsapp/start", post(wa_start))
        // Internal endpoints the WhatsApp sidecar pushes to.
        .route("/whatsapp/state", post(wa_state_push))
        .route("/whatsapp/import", post(wa_import))
        .route("/printers", get(printers))
        .route("/cancel", post(cancel))
        .route("/activity", get(activity_feed))
        .route("/diagnostics", get(diag))
}

#[derive(Debug, Deserialize, Default)]
struct WaStatePush {
    status: Option<String>,
    qr: Option<String>,
    #[serde(rename = "lastError")]
    last_error: Option<String>,
}

async fn wa_state_push(State(st): State<SharedState>, body: Bytes) -> Json<Value> {
    let b: WaStatePush = parse_body(&body);
    st.whatsapp.set_state(b.status.unwrap_or_else(|| "idle".into()), b.qr, b.last_error);
    Json(json!({ "ok": true }))
}

async fn wa_import(State(st): State<SharedState>, mut multipart: Multipart) -> AppResult<Json<Value>> {
    let mut file: Option<(Vec<u8>, String)> = None;
    let mut mime_type: Option<String> = None;
    let mut customer_name: Option<String> = None;
    let mut customer_phone: Option<String> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        match field.name().unwrap_or("") {
            "file" => {
                let filename = field.file_name().unwrap_or("file.bin").to_string();
                let data = field.bytes().await.map_err(|e| AppError::bad(e.to_string()))?;
                file = Some((data.to_vec(), filename));
            }
            "mimeType" => mime_type = field.text().await.ok(),
            "customerName" => customer_name = field.text().await.ok(),
            "customerPhone" => customer_phone = field.text().await.ok(),
            _ => {
                let _ = field.bytes().await;
            }
        }
    }
    let Some((buffer, original_name)) = file else { return Err(AppError::bad("file required")) };
    let result = media::save_incoming(
        &st.db,
        &st.config,
        Incoming { buffer, original_name, mime_type, customer_name, customer_phone, source: "whatsapp".into() },
    )?;
    Ok(Json(serde_json::to_value(result).unwrap_or(Value::Null)))
}

async fn status(State(st): State<SharedState>) -> AppResult<Json<Value>> {
    let counts = st.db.with(|c| jobs::count_by_status(c))?;
    Ok(Json(json!({
        "whatsapp": st.whatsapp.get_state(),
        "counts": counts,
        "presets": processing::preset_list(),
        "queue": st.print.snapshot(),
    })))
}

async fn wa_qr(State(st): State<SharedState>) -> Json<WaState> {
    Json(st.whatsapp.get_state())
}

async fn wa_start(State(st): State<SharedState>) -> AppResult<Json<WaState>> {
    st.whatsapp.start().await?;
    Ok(Json(st.whatsapp.get_state()))
}

async fn printers(State(st): State<SharedState>) -> Json<Vec<print::Printer>> {
    Json(st.print.list_printers(false).await)
}

async fn cancel(State(st): State<SharedState>) -> Json<Value> {
    let r = print::cancel_all(&st).await;
    Json(json!({ "ok": true, "cleared": r.cleared, "killed": r.killed, "reset": r.reset }))
}

#[derive(Debug, Deserialize, Default)]
struct ActivityQuery {
    limit: Option<i64>,
}

async fn activity_feed(State(st): State<SharedState>, Query(q): Query<ActivityQuery>) -> AppResult<Json<Vec<activity::ActivityRow>>> {
    let limit = q.limit.unwrap_or(25).min(100);
    Ok(Json(st.db.with(|c| activity::list(c, limit))?))
}

async fn diag(State(st): State<SharedState>) -> Json<diagnostics::Report> {
    Json(diagnostics::run(&st).await)
}
