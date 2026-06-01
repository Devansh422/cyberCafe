# Ratan — Build & Release (Rust + Tauri)

Ratan now ships as a single Windows desktop app: a **Rust backend** (axum,
`crates/ratan-core`) packaged with **Tauri v2** (`src-tauri`), with WhatsApp
handled by a **Node sidecar** (`whatsapp-sidecar/`) and auto-updates via GitHub
Releases.

```
Ratan.exe (Tauri)
├─ ratan-core  → axum HTTP API on 127.0.0.1:5000   (replaces the Express backend)
├─ WebView2    → static-exported Next.js UI (frontend/out) → fetch :5000/api
├─ whatsapp-sidecar.exe (Node, whatsapp-web.js)    spawned & supervised by ratan-core
├─ bundled resources: models/modnet.onnx, models/ultraface-RFB-320.onnx, SumatraPDF.exe
└─ tauri-plugin-updater → polls GitHub Releases latest.json
```

## Prerequisites
- Rust (MSVC host) + VS C++ Build Tools — installed.
- Node 18+.
- Tauri CLI: `npm i -D @tauri-apps/cli@^2` (in repo root) or `cargo install tauri-cli --version "^2"`.
- WebView2 runtime (ships with Windows 11).

## Develop
Run the backend and the Next.js dev server (the dev server proxies `/api` → :5000):
```powershell
# terminal 1 — backend
cargo run -p ratan-core --bin ratan-server
# terminal 2 — UI (http://localhost:4500)
npm --prefix frontend run dev
```
Or run everything in the Tauri shell (spawns the backend on a task, loads the UI):
```powershell
npx tauri dev          # uses src-tauri/tauri.conf.json (beforeDevCommand starts the UI)
```
Set `WHATSAPP_ENABLED=false` to skip the sidecar during UI work.

## Build the installer (local)
```powershell
# 1. Package the WhatsApp sidecar to dist/whatsapp-sidecar.exe
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm --prefix whatsapp-sidecar install
npm --prefix whatsapp-sidecar run package      # → dist/whatsapp-sidecar.exe

# 2. Ensure the print engine is present (already copied from pdf-to-printer, or download)
#    dist/SumatraPDF.exe

# 3. Build the NSIS installer (also runs frontend build:export)
npx tauri build
# → src-tauri/target/release/bundle/nsis/Ratan_<ver>_x64-setup.exe
```
> The sidecar resource is listed in `tauri.conf.json`, so package it into
> `dist/whatsapp-sidecar.exe` before running `npx tauri build`.

## Auto-update setup (one-time)
1. Generate the updater signing keypair:
   ```powershell
   npx tauri signer generate -w $HOME/.tauri/ratan.key
   ```
2. Put the **public** key in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`,
   and set `plugins.updater.endpoints[0]` to your repo's
   `https://github.com/<OWNER>/<REPO>/releases/latest/download/latest.json`.
3. Add GitHub Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the generated private key.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.

## Cut a release
```powershell
git tag v0.1.0
git push origin v0.1.0      # triggers .github/workflows/release.yml
```
The workflow builds the sidecar, fetches SumatraPDF, builds + signs the app, and
publishes a (draft) GitHub Release with the installer and `latest.json`.
Installed copies detect and apply the update on next launch.

## Notes
- Data lives under `%LOCALAPPDATA%\com.ratan.app\` (db, media-center, wwebjs_auth)
  in the packaged app; dev runs use the repo-relative paths (`backend/data/ratan.db`).
- Packaging `whatsapp-web.js` with `pkg` can be finicky (dynamic requires); if the
  sidecar exe misbehaves, an alternative is to bundle a portable Node runtime +
  `whatsapp-sidecar/` and launch `node server.js` via `WA_SIDECAR_*` env.
- The legacy `backend/` (Express) and `ecosystem.config.js`/PM2 scripts are
  superseded and can be removed once you've validated the packaged app.
```
