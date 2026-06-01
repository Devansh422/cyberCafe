# Ratan — Cyber Cafe Print Automation

WhatsApp → Media Center → One-Click Print, built per [plan.md](./plan.md) with the [Agilify](./design.md) design system.

```
Customer WhatsApp → Import Service → Local Media Center → Web Dashboard → Processing → Print Queue → Printer
```

## Layout

```
backend/        Express + SQLite + whatsapp-web.js + Sharp + pdf-lib + pdf-to-printer
frontend/       Next.js 14 (App Router) + Tailwind, mapped to Agilify design tokens
media-center/   Local file storage: incoming / processed / printed / failed / temp
```

## Prerequisites

- Node.js 18+ on Windows
- A default Windows printer configured for the operator account
- (First WhatsApp login) WhatsApp on a phone to scan the QR

## Install

```powershell
npm install
npm --prefix backend install
npm --prefix frontend install
```

Or shorthand:

```powershell
npm run install:all
```

Copy environment defaults:

```powershell
Copy-Item backend\.env.example backend\.env
```

## Run (dev)

```powershell
npm run dev
```

This starts both processes via `concurrently`:

- Backend: http://localhost:5000
- Frontend (dev): http://localhost:4500

In the PM2 production deployment (`ecosystem.config.js`) the frontend is served on **http://localhost:4500**.

The Next.js server proxies `/api/*` → backend (port 5000), so the frontend always calls relative `/api` URLs.

## First-time WhatsApp login

1. Open the frontend (dev: http://localhost:4500 · PM2: http://localhost:4500)
2. Click the **WhatsApp** chip in the top right
3. Click **Start / Refresh QR**, scan it from your phone (WhatsApp → Linked Devices → Link a Device)
4. Session persists locally in `backend/.wwebjs_auth` — no re-scan on restart

To disable WhatsApp during local UI work: set `WHATSAPP_ENABLED=false` in `backend/.env`.

## Flow

1. Customer sends a JPG / PNG / PDF / DOCX to the linked WhatsApp number
2. Backend downloads it, hashes it, dedupes by SHA-256, drops it in `media-center/incoming/`
3. Dashboard's **Incoming** view picks it up automatically (3-second refresh)
4. Operator selects card → picks a preset (Scan PDF / B&W / Color / High Contrast / Passport / A4) → **Process**
5. Operator picks printer + copies → **One-Click Print**
6. Print agent submits the PDF via `pdf-to-printer`, copies it to `media-center/printed/`, marks job `printed`

Manual upload is also supported from the **+ Upload** button.

## API (backend, port 4000)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/jobs?status=incoming` | List jobs by status |
| GET | `/api/jobs/:id` | One job |
| GET | `/api/jobs/:id/file[?processed=1]` | Stream original or processed file |
| POST | `/api/jobs/upload` | Multipart upload (manual import) |
| POST | `/api/jobs/:id/process` | `{ preset }` — render to PDF |
| POST | `/api/jobs/:id/print` | `{ printer, copies, orientation, paperSize, grayscale }` |
| DELETE | `/api/jobs/:id` | Remove job + files |
| GET | `/api/system/status` | WhatsApp state, counts, queue, presets |
| GET | `/api/system/whatsapp/qr` | Current QR data URL + status |
| POST | `/api/system/whatsapp/start` | Start / restart WhatsApp client |
| GET | `/api/system/printers` | List installed Windows printers |
| GET | `/api/system/activity?limit=25` | Recent activity feed |

## Data

SQLite at `backend/data/ratan.db` (auto-created):

- `print_jobs` — every imported file as a job with status incoming → processed → printing → printed (or failed)
- `customers` — phone → name mapping
- `activity_log` — timestamped events used by the right sidebar

## Design system

`frontend/src/app/globals.css` holds all CSS variables from [design.md](./design.md). `tailwind.config.js` re-exposes them as Tailwind tokens (e.g. `bg-bg-app`, `text-text-primary`, `rounded-pill`, `shadow-card`).

Cards, tags, badges, and the activity sidebar match the Agilify spec — same radii, same shadows, same date-badge color semantics (pink = overdue, yellow = today, green = future).

## What this build covers (MVP, plan.md §"MVP Scope")

- [x] Automatic WhatsApp import (whatsapp-web.js + LocalAuth)
- [x] Local media center with SHA-256 dedup, safe-extension filter
- [x] Browser dashboard (Incoming / Processed / Printed / Queue / Failed)
- [x] File preview (image + PDF) in panel
- [x] Image enhancement presets (Scan PDF / B&W / Color / High Contrast / Passport / A4)
- [x] One-click print via local print agent (`pdf-to-printer`)
- [x] Activity feed sidebar

Excluded (future, per plan.md): OCR, billing, AI enhancement, cloud sync, customer portal.

## Production

```powershell
npm --prefix frontend run build
npm run start
```

For a real cafe install, register backend + frontend as Windows services (e.g. `node-windows` or `nssm`) so they survive reboots.
