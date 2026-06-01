# Cyber Cafe Print Automation System

## Project Overview

A local-first browser-based print automation system for cyber cafes that automatically imports files from WhatsApp, stores them in a media center, processes them for printing, and enables one-click printing.

---

# Problem Statement

Current workflow is highly manual:

1. Customer sends files on WhatsApp
2. Operator downloads files manually
3. Operator processes files manually
4. Operator converts files to printable PDF
5. Operator selects printer
6. Operator prints

This consumes:

* time
* clicks
* operator effort

Goal:
Reduce the process to:

```txt
Receive → Process → Print
```

---

# Primary Objectives

## MVP Goals

* Automatically receive files from WhatsApp
* Store files locally
* Display files in a browser dashboard
* Allow file preview
* Process files for printing
* Enable one-click printing

---

# System Architecture

```txt
Customer WhatsApp
        ↓
WhatsApp Import Service
        ↓
Local Media Center
        ↓
Web Dashboard
        ↓
Processing Pipeline
        ↓
Print Queue
        ↓
Local Print Agent
        ↓
Printer
```

---

# Tech Stack

| Layer                | Technology         |
| -------------------- | ------------------ |
| Frontend             | Next.js            |
| Styling              | Tailwind CSS       |
| UI Components        | shadcn/ui          |
| Backend              | Node.js + Express  |
| WhatsApp Integration | whatsapp-web.js    |
| Image Processing     | Sharp              |
| PDF Processing       | pdf-lib            |
| Printing             | pdf-to-printer     |
| Database             | SQLite (initially) |
| Local Runtime        | Windows PC         |
| Session Storage      | LocalAuth          |

---

# Core Modules

---

# 1. WhatsApp Import Service

## Purpose

Automatically:

* monitor WhatsApp messages
* detect incoming media
* download files
* store files locally
* create print jobs

## Technology

* whatsapp-web.js
* Puppeteer
* Node.js

---

## Features

### QR Login

* Generate QR code
* Scan using WhatsApp mobile app
* Persist session using LocalAuth

### Media Detection

Supported:

* JPG
* PNG
* PDF
* DOCX

### Media Download

Automatically:

* download media
* save locally
* create metadata

---

## Folder Structure

```txt
/backend/services/whatsapp
```

---

## Error Handling

### Unsupported Files

Reject:

* .exe
* .zip
* .rar

### Corrupted Media

Retry:

* 3 attempts

### WhatsApp Disconnect

Auto reconnect logic.

### Session Expiry

Prompt QR regeneration.

---

# 2. Local Media Center

## Purpose

Acts as:

* centralized storage
* file management system
* processing workspace

---

# Storage Structure

```txt
/media-center
    /incoming
    /processed
    /printed
    /failed
    /temp
```

---

# File Naming Convention

```txt
timestamp_customer_filename.ext
```

Example:

```txt
20260528_aman_aadhar.jpg
```

---

# Features

* local file storage
* duplicate detection
* metadata indexing
* preview generation

---

# Error Handling

### Disk Full

* stop imports
* show warning

### Duplicate Files

* compare SHA256 hash
* mark duplicates

### Invalid MIME Type

* validate actual MIME
* reject unsafe files

---

# 3. Dashboard System

## Purpose

Browser-based operator interface.

---

# Features

## Media Grid

Display:

* preview
* filename
* customer
* type
* status

---

## Filters

Filter by:

* date
* customer
* type
* print status

---

## Actions

Buttons:

* Preview
* Process
* Convert PDF
* Print
* Delete

---

# Technology

* Next.js
* Tailwind CSS
* PDF.js

---

# Layout

```txt
Sidebar
    Incoming
    Processed
    Printed
    Failed

Main Content
    File Grid
    Preview Panel
    Print Queue
```

---

# 4. Processing Engine

## Purpose

Prepare documents for printing automatically.

---

# Image Processing Pipeline

```txt
Image
→ Resize
→ Sharpen
→ Denoise
→ Grayscale
→ A4 Fit
→ PDF Generation
```

---

# Features

## Scan PDF Mode

Convert images into:

* scanned-style PDFs

## Image Enhancement

* brightness correction
* contrast enhancement
* denoise
* sharpen

## Auto Fit

Automatically fit:

* A4
* Letter
* Passport size

---

# Libraries

## Image Processing

* Sharp

## PDF Generation

* pdf-lib

---

# Processing Presets

* Scan PDF
* Black & White
* Color Print
* High Contrast
* Passport Photo
* A4 Resize

---

# Error Handling

### Image Processing Failure

* rollback temp files
* preserve original

### PDF Conversion Failure

* retry once
* move to failed folder

---

# 5. Print System

## Purpose

Enable reliable one-click printing.

---

# IMPORTANT

Printing must NOT happen directly from browser.

Use:

```txt
Local Print Agent
```

---

# Print Flow

```txt
Dashboard
→ Backend API
→ Print Agent
→ Windows Printer
```

---

# Print Queue States

* pending
* printing
* completed
* failed

---

# Printing Technology

* pdf-to-printer

---

# Features

## Printer Selection

Select:

* laser printer
* color printer
* photo printer

## Print Settings

* copies
* orientation
* paper size
* grayscale

---

# Error Handling

### Printer Offline

Pause queue.

### Paper Jam

Retry later.

### Print Timeout

Cancel stuck jobs.

### Invalid Paper Size

Validate before printing.

---

# Database Design

## Initial Database

SQLite

---

# Suggested Tables

## print_jobs

| Field      | Type     |
| ---------- | -------- |
| id         | INTEGER  |
| filename   | TEXT     |
| type       | TEXT     |
| status     | TEXT     |
| created_at | DATETIME |

---

## customers

| Field | Type    |
| ----- | ------- |
| id    | INTEGER |
| phone | TEXT    |
| name  | TEXT    |

---

# Security Plan

## Dashboard Authentication

* PIN login
* local authentication

---

## File Restrictions

Allow only:

* jpg
* png
* pdf
* docx

---

## File Isolation

Never execute uploaded files.

---

## Auto Cleanup

Delete files after:

* 7–30 days

---

# MVP Scope

## Included

* WhatsApp import
* Local storage
* Dashboard
* File preview
* One-click print
* Basic processing

---

## Excluded Initially

* OCR
* Billing
* AI enhancement
* Cloud sync
* Customer portal

---

# Future Features

---

# OCR System

Use:

* Tesseract OCR

Capabilities:

* auto rotate
* text extraction
* Aadhaar detection

---

# AI Enhancement

Possible:

* shadow removal
* blur correction
* super resolution

---

# Customer Upload Portal

Alternative upload method:

```txt
local-upload-url
```

---

# Billing System

Generate:

* receipts
* print cost
* page count

---

# Analytics Dashboard

Track:

* daily prints
* revenue
* printer usage

---

# Recommended Development Phases

---

# Phase 1 — WhatsApp Import

Duration:
2–3 days

Tasks:

* setup WWebJS
* QR login
* auto media download
* local storage

---

# Phase 2 — Media Center

Duration:
2 days

Tasks:

* folder structure
* metadata indexing
* duplicate handling

---

# Phase 3 — Dashboard

Duration:
3–4 days

Tasks:

* file grid
* previews
* filters
* actions

---

# Phase 4 — Processing Engine

Duration:
4 days

Tasks:

* image enhancement
* A4 fit
* scanned PDF conversion

---

# Phase 5 — Print Agent

Duration:
2–3 days

Tasks:

* printer detection
* queue management
* one-click print

---

# Total Estimated MVP Timeline

```txt
10–14 Days
```

---

# Recommended Deployment

## Local-First Deployment

Run entire system on:

```txt
Main Cyber Cafe Windows PC
```

Includes:

* backend
* frontend
* WhatsApp importer
* print agent
* local storage

---

# Recommended Future Upgrade Path

```txt
MVP
→ Processing Automation
→ OCR
→ Billing
→ Customer Upload Portal
→ Multi-System Sync
→ Full SaaS
```

---

# Final Recommendation

Focus on:

```txt
WhatsApp Import
+
Media Center
+
One Click Print
```

before building advanced features.

This provides the highest operational value immediately for a cyber cafe workflow.
