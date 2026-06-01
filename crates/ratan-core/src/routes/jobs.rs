//! `/api/jobs/*` — ports `backend/src/routes/jobs.js`.

use axum::body::Bytes;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::jobs;
use crate::error::{AppError, AppResult};
use crate::media::{self, Incoming};
use crate::print::{self, PrintOptions};
use crate::processing;
use crate::routes::parse_body;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/", get(list).delete(bulk_delete))
        .route("/counts", get(counts))
        .route("/upload", post(upload))
        .route("/merge", post(merge))
        .route("/:id", get(get_one).delete(delete_one))
        .route("/:id/file", get(get_file))
        .route("/:id/process", post(process))
        .route("/:id/print", post(print_job))
        .route("/batch/:batch_id/process", post(batch_process))
        .route("/batch/:batch_id/print", post(batch_print))
        .route("/batch/:batch_id", axum::routing::delete(batch_delete))
}

#[derive(Debug, Deserialize, Default)]
struct ListQuery {
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list(State(st): State<SharedState>, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100);
    let offset = q.offset.unwrap_or(0);
    let jobs = st.db.with(|c| jobs::list_jobs(c, q.status.as_deref(), limit, offset))?;
    let counts = st.db.with(|c| jobs::count_by_status(c))?;
    Ok(Json(json!({ "jobs": jobs, "counts": counts })))
}

async fn counts(State(st): State<SharedState>) -> AppResult<Json<jobs::Counts>> {
    Ok(Json(st.db.with(|c| jobs::count_by_status(c))?))
}

async fn get_one(State(st): State<SharedState>, Path(id): Path<i64>) -> AppResult<Json<jobs::Job>> {
    st.db.with(|c| jobs::get_job(c, id))?.map(Json).ok_or(AppError::NotFound)
}

#[derive(Debug, Deserialize, Default)]
struct FileQuery {
    processed: Option<String>,
}

async fn get_file(State(st): State<SharedState>, Path(id): Path<i64>, Query(q): Query<FileQuery>) -> Response {
    let Some(job) = st.db.with(|c| jobs::get_job(c, id)).ok().flatten() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let which = if q.processed.as_deref() == Some("1") {
        match &job.processed_path {
            Some(p) => std::path::PathBuf::from(p),
            None => media::absolute_path(&st.config, &job.storage_folder, &job.filename),
        }
    } else {
        media::absolute_path(&st.config, &job.storage_folder, &job.filename)
    };
    if !which.exists() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(&which).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&which).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref().to_string())], bytes).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn upload(State(st): State<SharedState>, mut multipart: Multipart) -> AppResult<Response> {
    let mut file: Option<(Vec<u8>, String, Option<String>)> = None;
    let mut customer: Option<String> = None;
    let mut phone: Option<String> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                let filename = field.file_name().unwrap_or("file").to_string();
                let content_type = field.content_type().map(|s| s.to_string());
                let data = field.bytes().await.map_err(|e| AppError::bad(e.to_string()))?;
                file = Some((data.to_vec(), filename, content_type));
            }
            "customer" => customer = field.text().await.ok(),
            "phone" => phone = field.text().await.ok(),
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let Some((buffer, original_name, mime_type)) = file else {
        return Err(AppError::bad("file required"));
    };

    let result = media::save_incoming(
        &st.db,
        &st.config,
        Incoming {
            buffer,
            original_name,
            mime_type,
            customer_name: Some(customer.unwrap_or_else(|| "walk-in".to_string())),
            customer_phone: phone,
            source: "upload".into(),
        },
    )?;

    if !result.ok {
        return Ok((StatusCode::CONFLICT, Json(result)).into_response());
    }
    Ok((StatusCode::CREATED, Json(result.job)).into_response())
}

#[derive(Debug, Deserialize, Default)]
struct ProcessBody {
    preset: Option<String>,
}

async fn process(State(st): State<SharedState>, Path(id): Path<i64>, body: Bytes) -> AppResult<Json<jobs::Job>> {
    let b: ProcessBody = parse_body(&body);
    let preset = b.preset.unwrap_or_else(|| "scan_pdf".to_string());
    let job = processing::process_job(&st, id, &preset).await?;
    Ok(Json(job))
}

async fn print_job(State(st): State<SharedState>, Path(id): Path<i64>, body: Bytes) -> AppResult<Json<Value>> {
    let job = st.db.with(|c| jobs::get_job(c, id))?.ok_or(AppError::NotFound)?;
    let opts: PrintOptions = parse_body(&body);
    let queued = print::enqueue(st.clone(), job.id, opts);
    Ok(Json(json!({ "queued": queued, "jobId": job.id })))
}

#[derive(Debug, Deserialize, Default)]
struct MergeBody {
    #[serde(default)]
    ids: Vec<i64>,
    preset: Option<String>,
}

async fn merge(State(st): State<SharedState>, body: Bytes) -> AppResult<Response> {
    let b: MergeBody = parse_body(&body);
    let ids: Vec<i64> = b.ids.into_iter().filter(|n| *n > 0).collect();
    if ids.is_empty() {
        return Err(AppError::bad("select at least one item"));
    }
    let preset = b.preset.unwrap_or_else(|| "scan_pdf".to_string());
    let job = processing::merge_jobs_to_pdf(&st, &ids, &preset).await?;
    Ok((StatusCode::CREATED, Json(job)).into_response())
}

#[derive(Debug, Deserialize, Default)]
struct BatchProcessBody {
    preset: Option<String>,
}

async fn batch_process(
    State(st): State<SharedState>,
    Path(batch_id): Path<String>,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let jobs_in = st.db.with(|c| jobs::list_by_batch(c, &batch_id))?;
    if jobs_in.is_empty() {
        return Err(AppError::NotFound);
    }
    let b: BatchProcessBody = parse_body(&body);
    let preset = b.preset.unwrap_or_else(|| "scan_pdf".to_string());
    let mut results: Vec<Value> = Vec::new();
    for job in jobs_in {
        if job.status != "incoming" && job.status != "failed" {
            continue;
        }
        match processing::process_job(&st, job.id, &preset).await {
            Ok(j) => results.push(serde_json::to_value(j).unwrap_or(Value::Null)),
            Err(e) => results.push(json!({ "id": job.id, "error": e.to_string() })),
        }
    }
    Ok(Json(json!({ "ok": true, "processed": results.len(), "jobs": results })))
}

async fn batch_print(
    State(st): State<SharedState>,
    Path(batch_id): Path<String>,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let jobs_in = st.db.with(|c| jobs::list_by_batch(c, &batch_id))?;
    if jobs_in.is_empty() {
        return Err(AppError::NotFound);
    }
    let opts: PrintOptions = parse_body(&body);
    let mut queued = 0;
    for job in jobs_in {
        print::enqueue(st.clone(), job.id, opts.clone());
        queued += 1;
    }
    Ok(Json(json!({ "ok": true, "queued": queued })))
}

async fn batch_delete(State(st): State<SharedState>, Path(batch_id): Path<String>) -> AppResult<Json<Value>> {
    let jobs_in = st.db.with(|c| jobs::list_by_batch(c, &batch_id))?;
    if jobs_in.is_empty() {
        return Err(AppError::NotFound);
    }
    let mut deleted = 0;
    for job in jobs_in {
        media::delete_job_files(&st.config, &job);
        st.db.with(|c| jobs::delete_job(c, job.id))?;
        deleted += 1;
    }
    Ok(Json(json!({ "ok": true, "deleted": deleted })))
}

#[derive(Debug, Deserialize, Default)]
struct DeleteQuery {
    status: Option<String>,
}

async fn bulk_delete(State(st): State<SharedState>, Query(q): Query<DeleteQuery>) -> AppResult<Json<Value>> {
    let Some(status) = q.status else {
        return Err(AppError::bad("status query param required"));
    };
    let jobs_in = st.db.with(|c| jobs::list_jobs(c, Some(&status), 100_000, 0))?;
    let mut deleted = 0;
    for job in jobs_in {
        media::delete_job_files(&st.config, &job);
        st.db.with(|c| jobs::delete_job(c, job.id))?;
        deleted += 1;
    }
    Ok(Json(json!({ "ok": true, "deleted": deleted })))
}

async fn delete_one(State(st): State<SharedState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let job = st.db.with(|c| jobs::get_job(c, id))?.ok_or(AppError::NotFound)?;
    media::delete_job_files(&st.config, &job);
    st.db.with(|c| jobs::delete_job(c, job.id))?;
    Ok(Json(json!({ "ok": true })))
}
