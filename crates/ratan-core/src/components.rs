//! Externalized runtime components.
//!
//! The heavy, rarely-changing assets (MODNet model, UltraFace model,
//! `onnxruntime.dll`, `SumatraPDF.exe`, the WhatsApp sidecar) are **not** bundled
//! in the installer — that kept every auto-update at the full ~72 MB even though
//! only the app + frontend (~15 MB) actually change. Instead they are downloaded
//! once into a persistent app-data folder, verified by SHA-256, and reused across
//! updates, so the update artifact stays small.
//!
//! ## Per-file marker files
//!
//! Each component gets a tiny `.{filename}.sha256` sidecar in the components dir.
//! On startup the app reads only these tiny files to decide what needs work —
//! it never re-reads the 50–100 MB model weights just because an unrelated
//! component (e.g. the WhatsApp sidecar) changed in a release. The full file is
//! only re-hashed (via `spawn_blocking`) when the marker is absent or stale, and
//! only re-downloaded when the full hash check fails.
//!
//! The old global `.verified` file is no longer written; any existing copy is
//! left harmless on disk.
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

// ---- Per-file marker helpers ------------------------------------------------

fn marker_path(dir: &Path, filename: &str) -> PathBuf {
    dir.join(format!(".{filename}.sha256"))
}

/// Return true iff the per-file marker for `spec` is present, readable, and its
/// stored hash matches `spec.sha256`, **and** the component file itself exists.
///
/// Reads only a tiny text file (64 hex bytes), never the large component itself.
pub fn marker_ok(dir: &Path, spec: &ComponentSpec) -> bool {
    if !dir.join(&spec.file).exists() {
        return false;
    }
    match std::fs::read_to_string(marker_path(dir, &spec.file)) {
        Ok(stored) => stored.trim().eq_ignore_ascii_case(&spec.sha256),
        Err(_) => false,
    }
}

/// Return clones of the specs for which [`marker_ok`] is false — i.e. the
/// components that need verification or downloading on this boot.
///
/// Used by `spawn_bootstrap` to build the progress-bar total before `ensure_all`
/// runs, so the UI shows only the bytes actually being fetched.
pub fn specs_needing_work(dir: &Path, specs: &[ComponentSpec]) -> Vec<ComponentSpec> {
    specs.iter().filter(|s| !marker_ok(dir, s)).cloned().collect()
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

    /// Reset to a fresh "downloading" run for the given specs.
    ///
    /// Pass only the specs that actually need work (`specs_needing_work`) — not
    /// the full manifest — so the progress bar shows the real download size.
    pub fn reset(&self, specs: &[ComponentSpec]) {
        *self.inner.lock().unwrap() = Self::pending_status(specs);
    }

    fn recompute(g: &mut ComponentsStatus) {
        g.received = g.items.iter().map(|i| i.received).sum();
    }

    pub(crate) fn item(&self, key: &str, state: &str, received: u64, total: u64) {
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

/// SHA-256 a file (synchronous — always call via `spawn_blocking` for large files).
fn file_sha256(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Some(hex::encode(h.finalize()))
}

/// Ensure every component is present in `dir` and matches its manifest hash,
/// downloading any that are missing or corrupt. Updates `state` as bytes arrive.
///
/// Fast path: if a per-file `.sha256` marker file exists and matches the spec's
/// hash, the large component file is never read — just the tiny marker. This makes
/// post-update boot instant for components whose content didn't change.
///
/// `state` should be pre-initialised via `reset(&specs_needing_work(...))` so the
/// progress UI only shows bytes that are actually being fetched.
pub async fn ensure_all(dir: &Path, specs: &[ComponentSpec], state: &ComponentsState) -> anyhow::Result<()> {
    if specs.is_empty() {
        return Ok(());
    }
    tokio::fs::create_dir_all(dir).await?;

    // Lazily created only when we actually need to download something.
    let mut client: Option<reqwest::Client> = None;

    for spec in specs {
        let target = dir.join(&spec.file);
        let marker = marker_path(dir, &spec.file);

        // Fast path: valid per-file marker — trust it, no large-file I/O at all.
        if marker_ok(dir, spec) {
            state.item(&spec.key, "done", spec.size, spec.size);
            continue;
        }

        // Marker absent or stale but file exists: re-hash off the async thread to
        // avoid blocking the runtime. Write the marker and skip the download if it
        // matches — only the first boot after a marker-less install pays this cost.
        if target.exists() {
            let target2 = target.clone();
            let expected = spec.sha256.clone();
            let matches = tokio::task::spawn_blocking(move || {
                file_sha256(&target2)
                    .map(|h| h.eq_ignore_ascii_case(&expected))
                    .unwrap_or(false)
            })
            .await
            .unwrap_or(false);

            if matches {
                tokio::fs::write(&marker, &spec.sha256).await.ok();
                state.item(&spec.key, "done", spec.size, spec.size);
                continue;
            }
        }

        // File is absent or corrupt — download and verify.
        let cl = client.get_or_insert_with(reqwest::Client::new);
        state.item(&spec.key, "downloading", 0, spec.size);
        download_verify(cl, spec, &target, state).await?;
        tokio::fs::write(&marker, &spec.sha256).await.ok();
        state.item(&spec.key, "done", spec.size, spec.size);
    }

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
        let _ = manifest();
    }

    #[test]
    fn marker_ok_checks_hash() {
        let dir = std::env::temp_dir().join(format!("ratan-comp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let spec = ComponentSpec {
            key: "test".into(),
            file: "test.bin".into(),
            version: "1".into(),
            sha256: "abc123".into(),
            size: 3,
            url: "https://example.invalid/test.bin".into(),
        };
        // No file, no marker → false.
        assert!(!marker_ok(&dir, &spec));
        // File present, no marker → false.
        std::fs::write(dir.join("test.bin"), b"xyz").unwrap();
        assert!(!marker_ok(&dir, &spec));
        // File present, wrong marker → false.
        std::fs::write(dir.join(".test.bin.sha256"), "wronghash").unwrap();
        assert!(!marker_ok(&dir, &spec));
        // File present, correct marker (case-insensitive) → true.
        std::fs::write(dir.join(".test.bin.sha256"), "ABC123").unwrap();
        assert!(marker_ok(&dir, &spec));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_specs_ready() {
        let st = ComponentsState::pending(&[]);
        assert!(st.ready());
    }

    #[test]
    fn pending_total_reflects_specs() {
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
