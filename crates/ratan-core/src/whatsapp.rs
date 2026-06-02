//! WhatsApp connection — supervises the Node sidecar (whatsapp-web.js) and
//! exposes its state. The sidecar **pushes** status/QR to
//! `/api/system/whatsapp/state` (cached here) and posts imported media to
//! `/api/system/whatsapp/import`. `start()` spawns the sidecar (packaged exe in
//! production, `node whatsapp-sidecar/server.js` in dev) and asks it to begin.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use serde::Serialize;

use crate::config::Config;
use crate::error::AppResult;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize)]
pub struct WaState {
    pub enabled: bool,
    pub status: String,
    pub qr: Option<String>,
    #[serde(rename = "qrAge")]
    pub qr_age: Option<i64>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
}

struct Inner {
    status: String,
    qr: Option<String>,
    qr_generated_at: Option<i64>,
    last_error: Option<String>,
}

pub struct WhatsApp {
    enabled: bool,
    sidecar_port: u16,
    sidecar_path: Option<PathBuf>,
    sidecar_script: Option<PathBuf>,
    session_dir: PathBuf,
    core_port: u16,
    inner: Mutex<Inner>,
    child: Mutex<Option<Child>>,
}

impl WhatsApp {
    pub fn new(config: &Config) -> Self {
        WhatsApp {
            enabled: config.whatsapp_enabled,
            sidecar_port: config.sidecar_port,
            sidecar_path: config.sidecar_path.clone(),
            sidecar_script: config.sidecar_script.clone(),
            session_dir: config.session_dir.clone(),
            core_port: config.port,
            inner: Mutex::new(Inner {
                status: if config.whatsapp_enabled { "idle".into() } else { "disabled".into() },
                qr: None,
                qr_generated_at: None,
                last_error: None,
            }),
            child: Mutex::new(None),
        }
    }

    pub fn get_state(&self) -> WaState {
        let g = self.inner.lock().unwrap();
        let qr_age = g.qr_generated_at.map(|t| (chrono::Utc::now().timestamp_millis() - t) / 1000);
        WaState {
            enabled: self.enabled,
            status: g.status.clone(),
            qr: g.qr.clone(),
            qr_age,
            last_error: g.last_error.clone(),
        }
    }

    /// Update the cached state from a sidecar push.
    pub fn set_state(&self, status: String, qr: Option<String>, last_error: Option<String>) {
        let mut g = self.inner.lock().unwrap();
        g.qr_generated_at = if qr.is_some() { Some(chrono::Utc::now().timestamp_millis()) } else { None };
        g.status = status;
        g.qr = qr;
        g.last_error = last_error;
    }

    /// Spawn the sidecar (if not already running) and ask it to start the client.
    pub async fn start(&self) -> AppResult<()> {
        if !self.enabled {
            return Ok(());
        }
        self.ensure_spawned();

        // The sidecar's HTTP server comes up within ~1s; retry the /start POST.
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/start", self.sidecar_port);
        for _ in 0..6 {
            if client.post(&url).send().await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        tracing::warn!("[whatsapp] could not reach sidecar at {url} to start");
        Ok(())
    }

    /// Unlink the currently connected WhatsApp number and present a fresh QR so
    /// a different number can be linked. Forwards to the sidecar's `/logout`,
    /// which tells WhatsApp to drop the linked device, wipes the saved session,
    /// and auto-starts a new client.
    pub async fn logout(&self) -> AppResult<()> {
        if !self.enabled {
            return Ok(());
        }
        self.ensure_spawned();
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/logout", self.sidecar_port);
        for _ in 0..6 {
            if client.post(&url).send().await.is_ok() {
                self.set_state("logging_out".into(), None, None);
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        tracing::warn!("[whatsapp] could not reach sidecar at {url} to logout");
        Ok(())
    }

    fn ensure_spawned(&self) {
        let mut guard = self.child.lock().unwrap();
        // Already running?
        if let Some(ch) = guard.as_mut() {
            if matches!(ch.try_wait(), Ok(None)) {
                return; // still alive
            }
        }

        let mut cmd = match (&self.sidecar_path, &self.sidecar_script) {
            (Some(exe), _) => Command::new(exe),
            (None, Some(script)) => {
                let mut c = Command::new("node");
                c.arg(script);
                c
            }
            (None, None) => {
                drop(guard);
                self.set_state("unavailable".into(), None, Some("WhatsApp sidecar not found".into()));
                return;
            }
        };

        cmd.env("WA_PORT", self.sidecar_port.to_string())
            .env("CORE_URL", format!("http://127.0.0.1:{}", self.core_port))
            .env("WA_SESSION_DIR", &self.session_dir);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        match cmd.spawn() {
            Ok(child) => {
                tracing::info!("[whatsapp] sidecar spawned on port {}", self.sidecar_port);
                *guard = Some(child);
            }
            Err(e) => {
                drop(guard);
                tracing::error!("[whatsapp] failed to spawn sidecar: {e}");
                self.set_state("error".into(), None, Some(format!("sidecar spawn failed: {e}")));
            }
        }
    }
}

impl Drop for WhatsApp {
    fn drop(&mut self) {
        if let Ok(mut g) = self.child.lock() {
            if let Some(mut ch) = g.take() {
                // Kill the sidecar AND its Chromium descendants. A plain
                // `ch.kill()` only terminates the Node sidecar and leaves the
                // browser it spawned orphaned, holding the profile lock — the
                // exact cause of the next launch's "browser already running"
                // error. `taskkill /T` tears down the whole tree.
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let pid = ch.id().to_string();
                    let _ = Command::new("taskkill")
                        .args(["/PID", pid.as_str(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                }
                let _ = ch.kill();
            }
        }
    }
}
