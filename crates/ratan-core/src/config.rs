//! Runtime configuration — a Rust port of `backend/src/lib/config.js`.
//!
//! `Config::from_env()` reproduces the Node defaults so the standalone
//! `ratan-server` behaves identically to the old Express backend. The Tauri app
//! builds a `Config` explicitly (Phase 4) pointing media/db/session dirs at the
//! OS app-data location and models/SumatraPDF at the bundled resource dir.

use std::path::{Path, PathBuf};

/// Media-center subfolders (mirrors `config.folders`).
pub const FOLDERS: [&str; 5] = ["incoming", "processed", "printed", "failed", "temp"];

/// Extensions accepted on import (mirrors `config.allowedExtensions`).
pub const ALLOWED_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "pdf", "docx"];

/// Extensions always rejected (mirrors `config.blockedExtensions`).
pub const BLOCKED_EXTENSIONS: [&str; 7] = ["exe", "zip", "rar", "bat", "cmd", "msi", "scr"];

#[derive(Clone, Debug)]
pub struct Config {
    /// HTTP port (default 5000 — the frontend proxy/base targets this).
    pub port: u16,
    /// Root of the media center (incoming/processed/printed/failed/temp live here).
    pub media_root: PathBuf,
    /// SQLite database file.
    pub db_path: PathBuf,
    /// Whether to start the WhatsApp sidecar.
    pub whatsapp_enabled: bool,
    /// CORS origins allowed to call the API.
    pub allowed_origins: Vec<String>,
    /// Auto-purge printed jobs older than this many minutes (0 = disabled).
    pub printed_retention_minutes: i64,
    /// How often the cleanup sweep runs.
    pub cleanup_interval_minutes: i64,
    /// MODNet matting model (passport pipeline); `None` ⇒ matting degrades off.
    pub modnet_model: Option<PathBuf>,
    /// UltraFace detection model; `None` ⇒ centered-crop fallback.
    pub face_model: Option<PathBuf>,
    /// Directory holding bundled binaries (SumatraPDF) at runtime.
    pub resource_dir: PathBuf,
    /// WhatsApp `.wwebjs_auth` session directory (must be writable).
    pub session_dir: PathBuf,
    /// Packaged WhatsApp sidecar executable (`None` in pure dev runs).
    pub sidecar_path: Option<PathBuf>,
    /// Dev fallback: `node <this script>` when no packaged sidecar exe exists.
    pub sidecar_script: Option<PathBuf>,
    /// Local port the WhatsApp sidecar listens on.
    pub sidecar_port: u16,
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists()).cloned()
}

impl Config {
    /// Build a config from environment variables, rooted at `RATAN_ROOT` (or the
    /// current working directory). Matches `backend/src/lib/config.js` defaults,
    /// including the legacy `backend/data/ratan.db` location so an existing dev
    /// database is reused untouched.
    pub fn from_env() -> Self {
        let root = env_path("RATAN_ROOT")
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));

        let media_root = env_path("MEDIA_ROOT").unwrap_or_else(|| root.join("media-center"));
        let db_path = env_path("DB_PATH").unwrap_or_else(|| root.join("backend").join("data").join("ratan.db"));

        let whatsapp_enabled = std::env::var("WHATSAPP_ENABLED")
            .map(|v| v != "false")
            .unwrap_or(true);

        let allowed_origins = default_origins(std::env::var("ALLOWED_ORIGIN").ok().as_deref());

        let printed_retention_minutes = parse_int("PRINTED_RETENTION_MINUTES", 120);
        let cleanup_interval_minutes = parse_int("CLEANUP_INTERVAL_MINUTES", 10);

        let modnet_model = env_path("MODNET_ONNX").or_else(|| {
            first_existing(&[
                root.join("MODNet/pretrained/modnet.onnx"),
                root.join("MODNet/pretrained/modnet_photographic_portrait_matting.onnx"),
                root.join("MODNet/onnx/modnet.onnx"),
                root.join("MODNet/modnet.onnx"),
            ])
        });
        let face_model = env_path("FACE_ONNX").or_else(|| {
            first_existing(&[
                root.join("models/ultraface-RFB-320.onnx"),
                root.join("models/version-RFB-320.onnx"),
            ])
        });

        let resource_dir = env_path("RATAN_RESOURCE_DIR").unwrap_or_else(|| root.clone());
        let session_dir = env_path("WA_SESSION_DIR").unwrap_or_else(|| root.join("backend").join(".wwebjs_auth"));
        let sidecar_path = env_path("WA_SIDECAR_PATH");
        let sidecar_script = env_path("WA_SIDECAR_SCRIPT").or_else(|| {
            let s = root.join("whatsapp-sidecar").join("server.js");
            if s.exists() { Some(s) } else { None }
        });
        let sidecar_port = parse_int("WA_SIDECAR_PORT", 5099) as u16;

        Self {
            port: parse_int("PORT", 5000) as u16,
            media_root,
            db_path,
            whatsapp_enabled,
            allowed_origins,
            printed_retention_minutes,
            cleanup_interval_minutes,
            modnet_model,
            face_model,
            resource_dir,
            session_dir,
            sidecar_path,
            sidecar_script,
            sidecar_port,
        }
    }

    pub fn folder_path(&self, folder: &str) -> PathBuf {
        self.media_root.join(folder)
    }

    pub fn absolute_path(&self, folder: &str, filename: &str) -> PathBuf {
        self.folder_path(folder).join(filename)
    }

    /// Create the media-center subfolders (mirrors `media.ensureFolders`).
    pub fn ensure_folders(&self) -> std::io::Result<()> {
        for f in FOLDERS {
            std::fs::create_dir_all(self.media_root.join(f))?;
        }
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }
}

fn parse_int(key: &str, default: i64) -> i64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Origins allowed by CORS: the dev frontend (4500) plus the Tauri webview
/// origins (`tauri://localhost` and the Windows `https://tauri.localhost`).
fn default_origins(extra: Option<&str>) -> Vec<String> {
    let mut v = vec![
        "http://localhost:4500".to_string(),
        "http://localhost:3000".to_string(),
        "tauri://localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ];
    if let Some(e) = extra {
        if !v.iter().any(|o| o == e) {
            v.push(e.to_string());
        }
    }
    v
}

/// `true` if `ext` (without leading dot, any case) is importable.
pub fn is_allowed_ext(ext: &str) -> bool {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    if BLOCKED_EXTENSIONS.contains(&e.as_str()) {
        return false;
    }
    ALLOWED_EXTENSIONS.contains(&e.as_str())
}

/// Map an extension to a job `type` (mirrors `typeFromExtension`).
pub fn type_from_ext(ext: &str) -> &'static str {
    match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "png" => "image",
        "pdf" => "pdf",
        "docx" => "docx",
        _ => "other",
    }
}

/// Extension (lowercased, no dot) of a path, defaulting to `bin`.
pub fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".to_string())
}
