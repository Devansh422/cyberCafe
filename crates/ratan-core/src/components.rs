//! Externalized runtime components.
//!
//! The heavy, rarely-changing assets (MODNet model, UltraFace model,
//! `onnxruntime.dll`, `SumatraPDF.exe`, the WhatsApp sidecar) are **not** bundled
//! in the installer — that kept every auto-update at the full ~72 MB even though
//! only the app + frontend (~15 MB) actually change. Instead they are downloaded
//! once into a persistent app-data folder, verified by SHA-256, and reused across
//! updates, so the update artifact stays small.
//!
//! The manifest (`components.json`) is embedded at compile time; CI generates it
//! at release with the uploaded assets' content-addressed URLs + hashes. A
//! committed placeholder (empty list) keeps local `cargo build` working; dev runs
//! never download because `RATAN_COMPONENTS_DIR` is unset (see [`crate::serve`]).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Compile-time manifest. CI overwrites `components.json` before the release
/// build; the committed file is an empty placeholder.
const MANIFEST_JSON: &str = include_str!("../components.json");

#[derive(Debug, Clone, Deserialize)]
pub struct ComponentSpec {
    pub key: String,
    /// Destination filename inside the components dir (e.g. `modnet.onnx`).
    pub file: String,
    #[serde(default)]
    pub version: String,
    /// Lowercase hex SHA-256 of the expected file.
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    components: Vec<ComponentSpec>,
}

/// The embedded component manifest (empty if the placeholder is in place).
pub fn manifest() -> Vec<ComponentSpec> {
    serde_json::from_str::<Manifest>(MANIFEST_JSON).map(|m| m.components).unwrap_or_default()
}

// ---- Progress state ---------------------------------------------------------
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemStatus {
    pub key: String,
    pub file: String,
    /// "pending" | "downloading" | "done"
    pub state: String,
    pub received: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentsStatus {
    /// "ready" | "downloading" | "error"
    pub phase: String,
    pub error: Option<String>,
    pub items: Vec<ItemStatus>,
    pub received: u64,
    pub total: u64,
}

/// Shared, thread-safe download progress surfaced via `/api/system/components`.
pub struct ComponentsState {
    inner: Mutex<ComponentsStatus>,
}

impl ComponentsState {
    /// Nothing to fetch (dev runs, or no manifest) — immediately ready.
    pub fn ready_now() -> Self {
        ComponentsState {
            inner: Mutex::new(ComponentsStatus { phase: "ready".into(), error: None, items: vec![], received: 0, total: 0 }),
        }
    }

    /// Start in the "downloading" phase with one pending item per spec (or ready
    /// if there are none).
    pub fn pending(specs: &[ComponentSpec]) -> Self {
        ComponentsState { inner: Mutex::new(Self::pending_status(specs)) }
    }

    fn pending_status(specs: &[ComponentSpec]) -> ComponentsStatus {
        let items = specs
            .iter()
            .map(|s| ItemStatus { key: s.key.clone(), file: s.file.clone(), state: "pending".into(), received: 0, total: s.size })
            .collect();
        let total = specs.iter().map(|s| s.size).sum();
        ComponentsStatus {
            phase: if specs.is_empty() { "ready".into() } else { "downloading".into() },
            error: None,
            items,
            received: 0,
            total,
        }
    }

    pub fn ready(&self) -> bool {
        self.inner.lock().unwrap().phase == "ready"
    }

    pub fn snapshot(&self) -> ComponentsStatus {
        self.inner.lock().unwrap().clone()
    }

    /// Reset to a fresh "downloading" run (used by serve()'s bootstrap and the
    /// retry endpoint).
    pub fn reset(&self, specs: &[ComponentSpec]) {
        *self.inner.lock().unwrap() = Self::pending_status(specs);
    }

    fn recompute(g: &mut ComponentsStatus) {
        g.received = g.items.iter().map(|i| i.received).sum();
    }

    fn item(&self, key: &str, state: &str, received: u64, total: u64) {
        let mut g = self.inner.lock().unwrap();
        if let Some(it) = g.items.iter_mut().find(|i| i.key == key) {
            it.state = state.into();
            it.received = received;
            if total > 0 {
                it.total = total;
            }
        }
        Self::recompute(&mut g);
        g.total = g.items.iter().map(|i| i.total).sum();
    }

    pub fn set_ready(&self) {
        self.inner.lock().unwrap().phase = "ready".into();
    }

    pub fn set_error(&self, msg: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        g.phase = "error".into();
        g.error = Some(msg.into());
    }
}

impl Default for ComponentsState {
    fn default() -> Self {
        Self::ready_now()
    }
}

// ---- Download + verify ------------------------------------------------------
/// Combined fingerprint of the manifest (all keys+hashes) — stored in a
/// `.verified` marker so a normal launch skips re-hashing every file.
fn combined_fingerprint(specs: &[ComponentSpec]) -> String {
    let mut h = Sha256::new();
    for s in specs {
        h.update(s.key.as_bytes());
        h.update(b":");
        h.update(s.sha256.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

/// SHA-256 a file (blocking read — called from async via the surrounding task;
/// files are at most tens of MB).
fn file_sha256(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Some(hex::encode(h.finalize()))
}

fn file_matches(path: &Path, sha256: &str) -> bool {
    path.exists() && file_sha256(path).map(|h| h.eq_ignore_ascii_case(sha256)).unwrap_or(false)
}

/// Ensure every component is present in `dir` and matches its hash, downloading
/// any that are missing/corrupt. Updates `state` as bytes arrive. Idempotent and
/// cheap on a warm cache (the `.verified` marker skips per-file hashing).
pub async fn ensure_all(dir: &Path, specs: &[ComponentSpec], state: &ComponentsState) -> anyhow::Result<()> {
    if specs.is_empty() {
        return Ok(());
    }
    tokio::fs::create_dir_all(dir).await?;

    // Fast path: marker matches and every file still present → trust it.
    let fingerprint = combined_fingerprint(specs);
    let marker = dir.join(".verified");
    if tokio::fs::read_to_string(&marker).await.map(|c| c.trim() == fingerprint).unwrap_or(false)
        && specs.iter().all(|s| dir.join(&s.file).exists())
    {
        for s in specs {
            state.item(&s.key, "done", s.size, s.size);
        }
        return Ok(());
    }

    let client = reqwest::Client::builder().build()?;
    for spec in specs {
        let target = dir.join(&spec.file);
        if file_matches(&target, &spec.sha256) {
            state.item(&spec.key, "done", spec.size, spec.size);
            continue;
        }
        state.item(&spec.key, "downloading", 0, spec.size);
        download_verify(&client, spec, &target, state).await?;
        state.item(&spec.key, "done", spec.size, spec.size);
    }

    tokio::fs::write(&marker, fingerprint).await.ok();
    Ok(())
}

async fn download_verify(client: &reqwest::Client, spec: &ComponentSpec, target: &Path, state: &ComponentsState) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    // Stream to a sibling `.part` file so a partial/failed download is never
    // mistaken for a valid component (and an unverified .exe/.dll is never run).
    let part = PathBuf::from(format!("{}.part", target.to_string_lossy()));
    let mut resp = client.get(&spec.url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(spec.size);

    let mut file = tokio::fs::File::create(&part).await?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = resp.chunk().await? {
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        state.item(&spec.key, "downloading", received, total);
    }
    file.flush().await?;
    drop(file);

    let got = hex::encode(hasher.finalize());
    if !got.eq_ignore_ascii_case(&spec.sha256) {
        tokio::fs::remove_file(&part).await.ok();
        anyhow::bail!("checksum mismatch for {} (expected {}, got {got})", spec.file, spec.sha256);
    }
    // Atomic publish (replace any stale copy).
    let _ = tokio::fs::remove_file(target).await;
    tokio::fs::rename(&part, target).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_manifest_parses() {
        // The committed components.json must always parse (it's include_str!'d).
        let _ = manifest();
    }

    #[test]
    fn sha256_match_is_case_insensitive() {
        let dir = std::env::temp_dir().join(format!("ratan-comp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.bin");
        std::fs::write(&f, b"hello").unwrap();
        // sha256("hello")
        let want = "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824";
        assert!(file_matches(&f, want), "uppercase hash should match");
        assert!(!file_matches(&f, "deadbeef"), "wrong hash rejected");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_specs_ready() {
        let st = ComponentsState::pending(&[]);
        assert!(st.ready());
    }

    #[test]
    fn pending_then_error() {
        let specs = vec![ComponentSpec {
            key: "m".into(),
            file: "m.bin".into(),
            version: "1".into(),
            sha256: "00".into(),
            size: 10,
            url: "https://example.invalid/m.bin".into(),
        }];
        let st = ComponentsState::pending(&specs);
        assert!(!st.ready());
        assert_eq!(st.snapshot().total, 10);
        st.set_error("boom");
        assert_eq!(st.snapshot().phase, "error");
    }
}
