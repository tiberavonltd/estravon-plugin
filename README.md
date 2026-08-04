# Estravon — Plugin

Zotero 8+ plugin that adds an **"Extract Section to Markdown…"** context menu item
to Book, Book Section, Journal Article, Conference Paper, Report, Preprint,
Patent, Web Page, and Document items. Right-clicking a supported item with a
PDF attachment triggers a health check against the Python backend.

Web Page and Document support exists for a specific reason, not because
those types are typical extraction targets: they're the two parent item
types Zotero falls back to when a PDF ends up without the "correct" parent
type. Zotero's Connector falls back to a **Web Page** item when a page's
site translator fails to recognize it, even when what's actually being saved
is a PDF; local drag-and-drop defaults to the generic **Document** type when
Zotero's DOI/ISBN recognition fails. Either way, the plugin still requires a
PDF attachment on the item — a genuine Web Page or Document item with no PDF
never shows the menu item.

See [Features](#features) below for everything else the plugin does beyond the
core extraction flow — workspace export, note conversion, and large-PDF handling.

## Prerequisites

- Zotero 8.0 or newer
- The backend server running — see [`src/backend/README.md`](../backend/README.md)

---

## Install

1. Download the latest `.xpi` from [Releases](https://github.com/tiberavonltd/estravon-plugin/releases).
2. Open Zotero, go to **Tools → Add-ons**.
3. Click the gear icon (⚙) → **Install Add-on From File…**
4. Select the downloaded `.xpi`.
5. Restart Zotero when prompted.

Zotero auto-updates the plugin afterward via the manifest's `update_url`.

---

## Verifying the install

After restart, right-clicking a supported item type with a PDF attachment should
show **"Extract Section to Markdown…"** in the context menu.

Clicking it with the backend running shows an info dialog confirming:
- Item type, title, and Zotero item key
- PDF path on disk
- Active backend name (`"mistral"`, `"replicate"`, or `"datalab"`)
- Existing `.md` sections already attached

With the backend stopped, an error dialog shows the unreachable URL and the startup
command.

---

## Features

Beyond the core "extract a page range to Markdown" flow described above, the
right-click menu on a Zotero item (depending on its current type/content)
exposes:

- **Export to Workspace…** — copies extracted `.md` sections (and their
  images) out of Zotero's internal hash-named attachment storage into a
  clean, human-readable folder tree: `<workspacesRoot>/<workspace>/<book-slug>/`,
  with images rewritten into a workspace-relative `assets/` subfolder. This
  is what makes extracted content directly readable in Zettlr, Obsidian, or
  fed to an LLM agent without going through Zotero at all. Requires the
  `workspacesRoot` preference to be set first (**Zotero → Settings →
  Estravon → Workspace Export**); the dialog lets you pick an existing
  workspace or create a new one, and choose which of the item's sections to
  include.
- **Convert to Zotero note** — shown on a `.md` attachment; renders the
  markdown as HTML and creates a sibling Zotero note from it, for reading
  extracted content in Zotero's native note viewer/editor.
- **Convert to Markdown file** — the reverse: shown on a child note (other
  than the extraction log itself), converts its HTML content back into a
  `.md` file attachment.
- **Large-PDF handling** — before uploading, the plugin vendors
  [`pdf-lib`](https://pdf-lib.js.org/) to trim the source PDF down to just the
  requested page range whenever the file is larger than 30 MB, and refuses
  to upload anything still over 200 MB after trimming. This means a
  multi-hundred-MB scanned book can still be extracted from — only the
  pages you asked for ever leave your machine.
- **Force OCR** checkbox in the extraction dialog — discards the PDF's
  existing text layer and re-OCRs from scratch. On by default for Patent
  items (which frequently have a garbled or missing text layer); available
  as an option for any item type.
- **First-launch onboarding** — if the configured backend is unreachable
  the first time the plugin is used, it opens a one-time "Get started at
  estravon.com" prompt instead of a bare connection-error dialog.
- **Live ping indicator** in the settings pane — confirm connectivity to the
  backend without opening the extraction dialog.

---

## Configuration

Plugin preferences are in **Zotero → Settings → Estravon**:

| Preference | Default | Description |
|---|---|---|
| `extensions.estravon.backendUrl` | `https://api.estravon.com` | Full URL of the Python backend. The default points at the hosted service (requires `apiKey`); for a self-hosted backend, change this to `http://localhost:7766` and leave `apiKey` empty |
| `extensions.estravon.apiKey` | *(empty)* | API key for the hosted backend. Not needed for self-hosted deployments |
| `extensions.estravon.defaultChunkSize` | `80` | Pages per extraction API call |
| `extensions.estravon.defaultMode` | `balanced` | `fast` / `balanced` / `accurate` |
| `extensions.estravon.workspacesRoot` | *(empty)* | Absolute path to the parent folder for **Export to Workspace…**; must be set before that command can be used |

To use a remote backend, change `backendUrl` to the server's address — no code
changes required.

---

## Extraction log format

After each successful extraction the plugin:

1. Appends a row to the `[estravon] Extraction log` child note on the item.
2. Adds the `estravon` tag to the parent item.

The extraction log note contains a 9-column HTML table:

| Column | Description |
|---|---|
| Date | Local `YYYY-MM-DD HH:MM` timestamp |
| Job ID | First 8 characters of the backend job UUID |
| Section | Section name (e.g. `chapter_01`) |
| Pages | PDF page range extracted |
| Mode | `fast` / `balanced` / `accurate` |
| Chunks | Number of API chunks |
| Backend | `mistral`, `datalab`, or `replicate` |
| PDF | Source PDF filename |
| Schema | Extraction schema version (e.g. `1.1.0`) |

---

## For developers

Building from source, packaging, the `Zotero.Estravon.extract()` hook API for
other plugins to call, and the plugin's Zotero API surface are documented in
[`DEVELOPMENT.md`](DEVELOPMENT.md).
