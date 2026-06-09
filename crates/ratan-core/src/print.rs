//! Printing — ports `backend/src/services/print/index.js`.
//!
//! Real now: printer enumeration (hidden PowerShell + 30 s cache), the serial
//! print queue, and `cancelAll` (kill the engine + reset stuck jobs). The actual
//! spool to `SumatraPDF.exe` is implemented in Phase 2 (`runPrint`); until the
//! bundled engine is present this degrades exactly like the JS did when
//! `pdf-to-printer` was missing — the job is marked failed with a clear reason.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::db::{activity, jobs};
use crate::proc;
use crate::state::SharedState;

const PRINTER_CACHE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
pub struct Printer {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub name: String,
    #[serde(rename = "paperSizes")]
    pub paper_sizes: Vec<String>,
    /// True for the machine's current default printer (so the UI can preselect it).
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    /// True if Windows reports the printer as offline / unavailable.
    pub offline: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PrintOptions {
    pub preset: Option<String>,
    pub printer: Option<String>,
    pub copies: Option<i64>,
    pub orientation: Option<String>,
    #[serde(rename = "paperSize")]
    pub paper_size: Option<String>,
    pub grayscale: bool,
}

#[derive(Debug, Clone)]
struct QueueItem {
    job_id: i64,
    options: PrintOptions,
}

#[derive(Debug, Serialize)]
pub struct QueueSnap {
    #[serde(rename = "jobId")]
    pub job_id: i64,
    pub printer: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CancelResult {
    pub cleared: usize,
    pub killed: bool,
    pub reset: usize,
}

pub struct PrintService {
    queue: Mutex<VecDeque<QueueItem>>,
    draining: Mutex<bool>,
    cache: Mutex<Option<(Instant, Vec<Printer>)>>,
}

impl PrintService {
    pub fn new() -> Self {
        PrintService {
            queue: Mutex::new(VecDeque::new()),
            draining: Mutex::new(false),
            cache: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> Vec<QueueSnap> {
        self.queue
            .lock()
            .unwrap()
            .iter()
            .map(|i| QueueSnap { job_id: i.job_id, printer: i.options.printer.clone() })
            .collect()
    }

    /// List installed printers via hidden PowerShell, cached for 30 s.
    pub async fn list_printers(&self, force: bool) -> Vec<Printer> {
        if !force {
            if let Some((at, list)) = self.cache.lock().unwrap().as_ref() {
                if at.elapsed() < PRINTER_CACHE {
                    return list.clone();
                }
            }
        }
        let out = proc::run_powershell(
            "Get-CimInstance Win32_Printer | Select-Object DeviceID,Name,Default,WorkOffline,@{n='paperSizes';e={$_.PrinterPaperNames}} | ConvertTo-Json -Compress",
        )
        .await;
        match out {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                let list = normalize_printers(&stdout);
                *self.cache.lock().unwrap() = Some((Instant::now(), list.clone()));
                list
            }
            Err(e) => {
                tracing::error!("[print] listPrinters failed: {e}");
                // Serve a stale cache rather than an empty dropdown.
                self.cache.lock().unwrap().as_ref().map(|(_, l)| l.clone()).unwrap_or_default()
            }
        }
    }

    fn push(&self, item: QueueItem) -> usize {
        let mut q = self.queue.lock().unwrap();
        q.push_back(item);
        q.len()
    }

    fn pop(&self) -> Option<QueueItem> {
        self.queue.lock().unwrap().pop_front()
    }
}

impl Default for PrintService {
    fn default() -> Self {
        Self::new()
    }
}

/// Enqueue a job and ensure the drain task is running. Returns the queue length.
pub fn enqueue(state: SharedState, job_id: i64, options: PrintOptions) -> usize {
    let n = state.print.push(QueueItem { job_id, options });
    {
        let mut draining = state.print.draining.lock().unwrap();
        if !*draining {
            *draining = true;
            let st = state.clone();
            tokio::spawn(async move {
                drain(st).await;
            });
        }
    }
    n
}

async fn drain(state: SharedState) {
    loop {
        let item = state.print.pop();
        let Some(item) = item else { break };
        if let Err(e) = run_print(&state, item.job_id, &item.options).await {
            tracing::error!("[print] job failed: {e}");
        }
    }
    *state.print.draining.lock().unwrap() = false;
}

async fn run_print(state: &SharedState, job_id: i64, options: &PrintOptions) -> anyhow::Result<()> {
    let job = state.db.with(|c| jobs::get_job(c, job_id))?;
    let Some(job) = job else { anyhow::bail!("job not found") };

    // Printing requires an already-processed PDF (the UI guarantees this).
    let pdf_ok = job
        .processed_path
        .as_ref()
        .map(|p| std::path::Path::new(p).exists() && p.to_lowercase().ends_with(".pdf"))
        .unwrap_or(false);
    if !pdf_ok {
        mark_failed(state, job_id, "process to PDF before printing", "not processed — process to PDF before printing");
        return Ok(());
    }

    state.db.with(|c| {
        let _ = jobs::update_job(
            c,
            job_id,
            &jobs::JobPatch {
                status: Some("printing".into()),
                printer: options.printer.clone(),
                copies: Some(options.copies.unwrap_or(1)),
                ..Default::default()
            },
        );
        activity::log(c, Some(job_id), "printing", Some(&format!("→ {}", options.printer.as_deref().unwrap_or("default"))));
    });

    // Phase 2 spools to the bundled SumatraPDF here. Until it is wired, degrade
    // like the old backend did when pdf-to-printer was absent.
    if !crate::processing::print_engine_available(&state.config) {
        mark_failed(state, job_id, "pdf-to-printer not installed", "pdf-to-printer missing");
        return Ok(());
    }
    crate::processing::spool_to_printer(&state.config, &job, options).await?;

    let pdf_path = job.processed_path.clone().unwrap();
    let printed_dir = state.config.folder_path("printed");
    let _ = std::fs::create_dir_all(&printed_dir);
    let printed_path = printed_dir.join(std::path::Path::new(&pdf_path).file_name().unwrap());
    let _ = std::fs::copy(&pdf_path, &printed_path);

    state.db.with(|c| {
        let _ = jobs::update_job(
            c,
            job_id,
            &jobs::JobPatch {
                status: Some("printed".into()),
                printed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            },
        );
        activity::log(c, Some(job_id), "printed", Some(&format!("via {}", options.printer.as_deref().unwrap_or("default"))));
    });
    Ok(())
}

fn mark_failed(state: &SharedState, job_id: i64, error: &str, activity_detail: &str) {
    state.db.with(|c| {
        let _ = jobs::update_job(c, job_id, &jobs::JobPatch { status: Some("failed".into()), error: Some(error.into()), ..Default::default() });
        activity::log(c, Some(job_id), "print_failed", Some(activity_detail));
    });
}

/// Stop everything: drop the queue, kill the print engine, reset stuck jobs.
pub async fn cancel_all(state: &SharedState) -> CancelResult {
    let cleared = {
        let mut q = state.print.queue.lock().unwrap();
        let n = q.len();
        q.clear();
        n
    };

    let killed = proc::run_hidden("taskkill", &["/F", "/T", "/IM", "SumatraPDF.exe"]).await.is_ok();

    let mut reset = 0usize;
    let printing = state.db.with(|c| jobs::list_jobs(c, Some("printing"), 100_000, 0)).unwrap_or_default();
    for job in printing {
        state.db.with(|c| {
            let _ = jobs::update_job(c, job.id, &jobs::JobPatch { status: Some("failed".into()), error: Some("cancelled by operator".into()), ..Default::default() });
            activity::log(c, Some(job.id), "print_cancelled", Some("killed by operator"));
        });
        reset += 1;
    }

    *state.print.draining.lock().unwrap() = false;
    state.db.with(|c| {
        activity::log(c, None, "queue_cancelled", Some(&format!("Cleared {cleared} queued · print engine killed · {reset} reset")))
    });
    CancelResult { cleared, killed, reset }
}

/// Parse `ConvertTo-Json` output into printers, tolerating a single object vs an
/// array and `paperSizes` arriving as a bare array or `{ value: [...] }`.
fn normalize_printers(stdout: &str) -> Vec<Printer> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let arr = match parsed {
        serde_json::Value::Array(a) => a,
        other => vec![other],
    };
    arr.into_iter()
        .filter_map(|p| {
            let name = p.get("Name").and_then(|v| v.as_str());
            let device = p.get("DeviceID").and_then(|v| v.as_str());
            if name.is_none() && device.is_none() {
                return None;
            }
            let paper = p.get("paperSizes");
            let paper_sizes = extract_paper_sizes(paper);
            let is_default = p.get("Default").and_then(|v| v.as_bool()).unwrap_or(false);
            let offline = p.get("WorkOffline").and_then(|v| v.as_bool()).unwrap_or(false);
            Some(Printer {
                device_id: device.or(name).unwrap_or_default().to_string(),
                name: name.or(device).unwrap_or_default().to_string(),
                paper_sizes,
                is_default,
                offline,
            })
        })
        .collect()
}

fn extract_paper_sizes(v: Option<&serde_json::Value>) -> Vec<String> {
    let arr = match v {
        Some(serde_json::Value::Array(a)) => a.clone(),
        Some(serde_json::Value::Object(o)) => match o.get("value") {
            Some(serde_json::Value::Array(a)) => a.clone(),
            _ => return vec![],
        },
        _ => return vec![],
    };
    arr.into_iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
}
