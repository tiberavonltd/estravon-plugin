# Changelog

All notable changes to Estravon are documented here.

---

## [0.4.1] — 2026-06-27

### Plugin

- **First-launch onboarding:** on fresh install the plugin opens `estravon.com/start`
  in the browser so new users are guided to either the hosted service or the
  self-hosted setup guide.
- **Hosted backend support:** plugin polls `GET /jobs/{id}` with progressive backoff
  (3 s × 20, then 10 s) when the server returns HTTP 202 (async job queued). API key
  sent as `X-API-Key` header when set in preferences.
- **Workspace export:** "Export to Workspace…" context menu item copies `.md` and image
  attachments into a structured folder tree, rewriting Zotero-internal image links to
  relative `assets/` paths.
- **Note conversion:** "Convert to Zotero note" and "Convert to Markdown file" context
  menu items for round-tripping between `.md` attachments and Zotero notes.
- **Traceability log:** extraction log note now records force-OCR flag and PDF filename.

### Backend (`estravon-backend` 0.4.1)

- **Primary backend: Mistral OCR** (`mistral-ocr-latest`). Replicate and Datalab
  remain available via the `_ZM_BACKEND` environment variable.
- **3-state FSM:** `/ping` returns `{"status":"ok","state":"idle"|"running"|"error","backend":"..."}`.
  New `GET /status` endpoint returns full state with elapsed time and last-job details.
- **`pypdf` page splitting:** `_split_pages()` rewritten to use pure-Python `pypdf`
  (removes the `pikepdf` C-extension dependency that caused SIGSEGV on some PDFs).
- **Force-OCR mode:** `force_ocr=true` discards the existing text layer and re-OCRs
  via Mistral — useful for patents and image-only PDFs.

---

## [0.1.0-alpha] — 2026-04-23

First public release.

### Plugin

- Right-click extraction menu on Book, Book Section, and Journal Article items
  with PDF attachments
- Extraction dialog: section name (auto-incremented), page range, chunk size,
  mode selector (`fast` / `balanced` / `accurate`)
- TOC shortcut: checkbox sets section name to `table_of_contents` and locks
  the field
- Journal article / conference paper dialog: single-file default; optional
  split into named sections
- PDF bytes uploaded as multipart to the local backend; results downloaded and
  attached as Zotero child attachments
- Extraction log: child note on each item records chunk UUIDs, page ranges,
  backend used, status, and timestamp for full traceability
- Settings pane: configurable backend URL; live connectivity indicator
- Supports local backend at `http://localhost:7766` (default) or any remote
  address

### Backend (`estravon-backend` 0.1.0)

- FastHTML server: `GET /ping`, `POST /process` (multipart PDF upload),
  `GET /files/<job_id>/<filename>`, `GET /schema-registry`
- Extraction backends: Replicate (`datalab-to/marker`, blocking) and Datalab
  (native `page_range`, async polling); automatic Replicate → Datalab fallback
- Page splitting via `pikepdf` (Replicate backend)
- Chunking: configurable chunk size, pure Python, no I/O
- Content statistics embedded in every `.md` footer: word count, sentence
  count, vocabulary profile, type-token ratio; optional named-entity extraction
  via spaCy
- Schema versioning: `SCHEMA_VERSION = "1.1.0"` in every footer and state
  record; enables future migration tooling
- Schema registry: `schema_registry.json` served at `GET /schema-registry`
- Provenance footer in every `.md` file: job UUID, chunk UUID, source item
  key, page range, backend, extraction date, schema version

### Known limitations

- One extraction at a time (synchronous blocking); concurrent requests are
  rejected with a clear error message
- Backend must run on the same machine as Zotero (localhost only in default
  configuration)
- Agent mode and hosted remote backend are not included in this release
  (planned for v0.2.0-beta and v0.3.0)
