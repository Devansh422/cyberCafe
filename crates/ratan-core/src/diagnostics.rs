//! Self-diagnostics — ports `backend/src/services/diagnostics/index.js`.
//! Produces the same `{ overall, summary, checks, generatedAt }` JSON the
//! dashboard renders. Check ids/labels are kept identical so the UI is unchanged.

use std::path::PathBuf;

use serde::Serialize;

use crate::config::{Config, FOLDERS};
use crate::processing;
use crate::state::SharedState;

#[derive(Debug, Serialize)]
pub struct Check {
    pub id: String,
    pub label: String,
    pub status: String, // "ok" | "warn" | "error"
    pub detail: String,
    pub fix: Option<String>,
}

fn ok(id: &str, label: &str, detail: String) -> Check {
    Check { id: id.into(), label: label.into(), status: "ok".into(), detail, fix: None }
}
fn warn(id: &str, label: &str, detail: String, fix: &str) -> Check {
    Check { id: id.into(), label: label.into(), status: "warn".into(), detail, fix: Some(fix.into()) }
}
fn fail(id: &str, label: &str, detail: String, fix: &str) -> Check {
    Check { id: id.into(), label: label.into(), status: "error".into(), detail, fix: Some(fix.into()) }
}

fn check_runtime() -> Check {
    ok("node", "Backend runtime", format!("ratan-core {}", env!("CARGO_PKG_VERSION")))
}

fn check_media(config: &Config) -> Check {
    let missing: Vec<&str> = FOLDERS.iter().copied().filter(|f| !config.media_root.join(f).exists()).collect();
    if missing.is_empty() {
        let probe = config.media_root.join("temp").join(format!(".diag-{}", chrono::Utc::now().timestamp_millis()));
        match std::fs::write(&probe, b"ok") {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
                ok("media", "Media center folders", format!("All folders present under {}", config.media_root.display()))
            }
            Err(e) => fail(
                "media",
                "Media center folders",
                format!("Cannot write to {}: {e}", config.media_root.display()),
                "Check folder permissions, or that the drive is not full / read-only.",
            ),
        }
    } else {
        fail(
            "media",
            "Media center folders",
            format!("Missing: {}", missing.join(", ")),
            "Restart the app, which recreates the media-center folders automatically.",
        )
    }
}

fn check_database(config: &Config) -> Check {
    let dir = config.db_path.parent().map(PathBuf::from).unwrap_or_default();
    if !dir.exists() {
        return fail(
            "database",
            "Database",
            format!("DB folder missing: {}", dir.display()),
            "Restart the app — it recreates the data folder and ratan.db automatically.",
        );
    }
    let exists = config.db_path.exists();
    ok(
        "database",
        "Database",
        if exists { "ratan.db present and writable".into() } else { "data folder writable (db created on first write)".into() },
    )
}

fn check_print_engine(config: &Config) -> Check {
    match processing::find_sumatra(config) {
        Some(p) => ok(
            "print-engine",
            "Print engine",
            format!("SumatraPDF ready ({})", p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
        ),
        None => fail(
            "print-engine",
            "Print engine",
            "Bundled SumatraPDF binary missing".into(),
            "Reinstall the application; the print engine ships with it.",
        ),
    }
}

async fn check_printers(state: &SharedState) -> Check {
    let list = state.print.list_printers(false).await;
    if list.is_empty() {
        warn(
            "printers",
            "Installed printers",
            "No printers detected".into(),
            "Add a printer in Windows Settings → Bluetooth & devices → Printers & scanners, and set one as default.",
        )
    } else {
        let names: Vec<String> = list.iter().map(|p| p.name.clone()).collect();
        ok("printers", "Installed printers", format!("{} found: {}", list.len(), names.join(", ")))
    }
}

fn find_chrome() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let candidates = [
        PathBuf::from(&local).join("Google/Chrome/Application/chrome.exe"),
        PathBuf::from("C:/Program Files/Google/Chrome/Application/chrome.exe"),
        PathBuf::from("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
        PathBuf::from("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
        PathBuf::from("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn check_browser(config: &Config) -> Check {
    if !config.whatsapp_enabled {
        return ok("browser", "Browser engine (for WhatsApp)", "WhatsApp disabled — browser not required".into());
    }
    match find_chrome() {
        Some(p) => ok(
            "browser",
            "Browser engine (for WhatsApp)",
            format!("Using {}", p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
        ),
        None => fail(
            "browser",
            "Browser engine (for WhatsApp)",
            "No Chrome/Edge found — WhatsApp cannot start".into(),
            "Install Google Chrome (https://google.com/chrome). WhatsApp Web automation needs a Chromium browser.",
        ),
    }
}

fn check_whatsapp(state: &SharedState) -> Check {
    let s = state.whatsapp.get_state();
    if !s.enabled {
        return ok("whatsapp", "WhatsApp connection", "Disabled via WHATSAPP_ENABLED=false".into());
    }
    if s.status == "ready" || s.status == "authenticated" {
        return ok("whatsapp", "WhatsApp connection", format!("Connected ({})", s.status));
    }
    let detail = match &s.last_error {
        Some(e) => format!("{} — {}", s.status, e),
        None => s.status.clone(),
    };
    let fix = wa_fix(&s.status);
    let status = if ["failed", "error", "auth_failed", "unavailable"].contains(&s.status.as_str()) { "error" } else { "warn" };
    Check { id: "whatsapp".into(), label: "WhatsApp connection".into(), status: status.into(), detail, fix }
}

fn wa_fix(status: &str) -> Option<String> {
    let f = match status {
        "disabled" | "ready" | "authenticated" => return None,
        "idle" => "Open the WhatsApp tab and click \"Start / Refresh QR\".",
        "starting" => "Client is starting — wait a few seconds and refresh.",
        "loading" => "Client is loading WhatsApp Web — wait for it to finish.",
        "awaiting_qr" => "Open the WhatsApp tab and scan the QR with your phone within 60 seconds.",
        "auth_failed" => "Authentication failed. Re-link by scanning a fresh QR.",
        "disconnected" => "WhatsApp disconnected. It auto-reconnects; if not, restart the app.",
        "error" => "WhatsApp failed to start. Confirm Chrome is installed and you have internet, then restart.",
        "unavailable" => "The WhatsApp sidecar is not available in this build yet.",
        "failed" => "WhatsApp gave up after repeated reconnects. Restart the app to retry.",
        _ => "Open the WhatsApp tab to check the connection and re-link if needed.",
    };
    Some(f.to_string())
}

#[derive(Debug, Serialize)]
pub struct Summary {
    pub ok: usize,
    pub warn: usize,
    pub error: usize,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub overall: String,
    pub summary: Summary,
    pub checks: Vec<Check>,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

pub async fn run(state: &SharedState) -> Report {
    let mut checks = vec![
        check_runtime(),
        check_media(&state.config),
        check_database(&state.config),
        check_print_engine(&state.config),
    ];
    checks.push(check_printers(state).await);
    checks.push(check_browser(&state.config));
    checks.push(check_whatsapp(state));

    let summary = Summary {
        ok: checks.iter().filter(|c| c.status == "ok").count(),
        warn: checks.iter().filter(|c| c.status == "warn").count(),
        error: checks.iter().filter(|c| c.status == "error").count(),
    };
    let overall = if summary.error > 0 { "error" } else if summary.warn > 0 { "warn" } else { "ok" };
    Report { overall: overall.into(), summary, checks, generated_at: chrono::Utc::now().to_rfc3339() }
}
