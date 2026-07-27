# Estravon — Plugin

Zotero 8+ plugin that adds an **"Extract Section to Markdown…"** context menu item
to Book, Book Section, Journal Article, Conference Paper, Report, Preprint, and
Patent items. Right-clicking a supported item with a PDF attachment triggers a
health check against the Python backend. The extraction dialog and attachment
logic are implemented in Milestone 3 and 4.

See [Features](#features) below for everything else the plugin does beyond the
core extraction flow — workspace export, note conversion, and large-PDF handling.

## Prerequisites

- Zotero 8.0 or newer
- The backend server running — see [`src/backend/README.md`](../backend/README.md)

---

## What is an `.xpi` file?

A `.xpi` file is a **renamed ZIP archive**. Zotero (like Firefox) treats it as a
standard ZIP and extracts it when installing a plugin. The name `.xpi` stands for
*Cross-Platform Installer*, a format inherited from the Mozilla platform.

The only structural requirement is that **`manifest.json` must be at the root of the
archive** — not inside a subdirectory. Zotero reads this file first to discover the
plugin's ID, name, version, and compatibility range. If `manifest.json` is missing
or in a subdirectory, Zotero rejects the file at install time with no error message.

Everything else in the archive is referenced relative to that root:
- `bootstrap.js` — loaded by Zotero as the plugin entry point
- `prefs.js` — read once at install time to register preference defaults
- `estravon.js` — loaded by `bootstrap.js` via `loadSubScript()`
- `content/` — chrome-registered directory; icons and XUL dialogs live here
- `locale/` — chrome-registered directory; Fluent `.ftl` string files live here

Files that are **not included** in the `.xpi`:
- `jsconfig.json` — VS Code type-checking config; has no runtime effect
- `README.md` — developer documentation only
- `icons/` — old root-level icons, superseded by `content/icons/`

---

## Packaging: what the `zip` command does

```bash
cd src/plugin
zip -r ../../builds/estravon-0.1.0.xpi \
    manifest.json      \
    bootstrap.js       \
    prefs.js           \
    estravon.js   \
    content/           \
    locale/
```

### Option breakdown

| Option / argument | Meaning |
|---|---|
| `-r` | **Recursive** — include all files inside any directory argument (`content/`, `locale/`) |
| `../../builds/estravon-0.1.0.xpi` | Output path; the `.xpi` extension is just a name — ZIP format inside |
| `manifest.json bootstrap.js …` | Individual files to include at the **root** of the archive |
| `content/` | Entire directory, included as `content/…` paths inside the archive |
| `locale/` | Entire directory, included as `locale/…` paths inside the archive |

### Why run `zip` from inside `src/plugin/`?

Running `zip` from the project root (`zip -r out.xpi src/plugin/`) would produce an
archive where every path is prefixed with `src/plugin/`, e.g.
`src/plugin/manifest.json`. Zotero would not find `manifest.json` at the archive
root and would reject the install.

Running from inside `src/plugin/` ensures paths are recorded as `manifest.json`,
`content/icons/marker-icon.png`, etc. — exactly what Zotero expects.

### Automated build script

`scripts/build_xpi.py` reads the version from `manifest.json` automatically and
writes to `builds/estravon-<version>.xpi`. It uses Python's built-in
`zipfile` module — no `zip` command or extra tools required.

```bash
# Works everywhere (Windows cmd/PowerShell/Git Bash, macOS, Linux):
python scripts/build_xpi.py

# Or via the bash wrapper (Git Bash / WSL / macOS / Linux):
bash scripts/build-xpi.sh
```

---

## Installing into Zotero

### Option A — `.xpi` file (for testing a release build)

Full cycle per change: edit → build → uninstall old → install new → restart Zotero.
Use this to verify a release build or to share the plugin with someone else.

1. Build the `.xpi`: `python scripts/build_xpi.py`
2. Open Zotero 8.
3. Go to **Tools → Add-ons**.
4. Click the gear icon (⚙) → **Install Add-on From File…**
5. Select `builds/estravon-<version>.xpi`.
6. Restart Zotero when prompted.

### Option B — proxy file (recommended during development)

Full cycle per change: edit → restart Zotero. No build step, no UI navigation.

The proxy file is a plain text file in Zotero's `extensions/` directory whose
name is the addon ID and whose content is the absolute path to `src/plugin/`.
Zotero reads plugin files directly from that path on every startup, so what is
on disk is what runs — with no packaging step in between.

**Advantages over Option A during development:**

- **No build step.** Edit a `.js` file, restart Zotero, done. No `zip`, no
  install, no uninstall.
- **No version number friction.** With `.xpi`, installing a build that has the
  same version number as the already-installed plugin may be silently ignored by
  Zotero ("already up to date"). With the proxy file, Zotero always reads from
  disk on startup regardless of version.
- **Stack traces point to your source files.** When Zotero loads a `.xpi`, it
  extracts it to a temporary cache location. Error messages in the error console
  (Tools → Developer → Error Console) reference that temp path. With the proxy
  file they reference the actual files in `src/plugin/`, so you can jump directly
  to the failing line.
- **No stale cache risk.** Launch Zotero with `-purgecaches` to force a clean
  reload of all scripts. With `.xpi`, cached compiled JS can persist across
  installs of the same version without you realising it.

**Setup using the install script (recommended):**

1. Copy `.env.example` to `.env` in the project root (if you haven't already).

2. Fill in the two path variables in `.env`:
   ```
   # Windows example:
   ZOTERO_PLUGIN_DIR=C:\Users\you\programming\parse_and_translate_files\src\plugin
   ZOTERO_PROFILE_DIR=C:\Users\you\AppData\Roaming\Zotero\Zotero\Profiles\xxxxxxxx.default

   # Linux/macOS example:
   ZOTERO_PLUGIN_DIR=/home/you/programming/parse_and_translate_files/src/plugin
   ZOTERO_PROFILE_DIR=/home/you/.zotero/zotero/xxxxxxxx.default
   ```
   To find your profile directory: **Zotero → Help → Show Data Directory**, then
   navigate up one level to `Profiles/xxxxxxxx.default`.

3. Run the install script from the project root:
   ```bash
   python scripts/install_proxy.py
   ```
   The script:
   - Creates the `extensions/` directory inside the profile if it does not exist.
   - Writes (or overwrites) the proxy file — a text file named after the addon ID
     whose content is the path to `src/plugin/`.
   - Patches `prefs.js` to remove `lastAppBuildId` / `lastAppVersion` so Zotero
     re-scans extensions on the next start.
   - Prints the platform-specific `-purgecaches` restart command.

4. Restart Zotero with `-purgecaches`. The plugin loads live from source.

> **First-time only:** On the very first `-purgecaches` restart after installing the
> proxy file, Zotero may load the plugin in a **disabled** state. Go to
> **Tools → Plugins**, find Estravon, and toggle it on. On every subsequent
> restart it will stay enabled automatically.

**Daily development loop:** edit a `.js` file → quit and restart Zotero. To also
flush Zotero's compiled-script cache (recommended when JS changes are not being
picked up), start Zotero with the `-purgecaches` flag:

- **Windows:** `"C:\Program Files\Zotero\zotero.exe" -purgecaches`
- **macOS:** `/Applications/Zotero.app/Contents/MacOS/zotero -purgecaches`
- **Linux:** `zotero -purgecaches`

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

## Developer API — triggering extraction from another Zotero plugin

If you're building a separate Zotero plugin and want to trigger Estravon extraction
programmatically — without reimplementing the backend HTTP contract or the
attach/log-note logic yourself — call the public hook Estravon registers on the
global `Zotero` object while it's active:

```js
if (Zotero.Estravon?.extract) {
  console.log("Estravon hook available, API version", Zotero.Estravon.apiVersion);
}
```

### `Zotero.Estravon.extract(options)`

```js
const result = await Zotero.Estravon.extract({
  itemID,            // required — Zotero item ID to attach results to
  pdfAttachmentID,    // optional — which PDF attachment; defaults to the item's
                      // first PDF attachment in attachment order if omitted
  pageRange,          // required — 1-based inclusive, e.g. "112-148"
  sectionName,        // required — label for the result + log note
  mode,               // optional — "fast" | "balanced" | "accurate", default from prefs
  chunkSize,          // optional — pages per API call, default from prefs
  forceOcr,           // optional — default false
  attach,             // optional — default true (see below)
  silent,             // optional — default true (see below)
});
```

**Never rejects.** `extract()` always resolves — even on failure — so you get a
predictable shape back rather than needing a `try`/`catch` around every call:

```ts
{
  status: "done" | "error",
  jobId?: string,
  markdown?: { label: string, markdown: string }[],  // present when attach:false
  attachmentIDs?: number[],                          // present when attach:true
  error?: string,                                    // present when status is "error"
}
```

**`attach` (default `true`)** — controls whether Estravon files the result for you:
- `attach: true` (default) — full plugin behaviour: downloads and attaches the `.md`
  (and any images) to the Zotero item, writes/updates the `[estravon] Extraction log`
  note, and tags the item `estravon`. `attachmentIDs` in the result are the created
  `.md` attachments' Zotero item IDs (not the image attachments).
- `attach: false` — no Zotero-side filing at all. Resolves with the raw markdown text
  per chunk instead; you handle attaching, note-writing, or anything else yourself.
  Image references inside the returned markdown are left as the backend's relative
  `/files/...` URLs (there are no Zotero attachment keys to rewrite them to in this
  mode) — resolve them against your own configured backend URL if you need the images.

**`silent` (default `true`)** — controls whether a failure also pops Estravon's own
error dialog in the user's Zotero window:
- `silent: true` (default) — failures are silent; you get `{status:"error", error}`
  and decide yourself whether/how to surface it. This is the default because a caller
  triggering extraction in the background shouldn't have Estravon pop an unsolicited
  modal dialog the user has no context for.
- `silent: false` — Estravon also shows its own native error dialog (the same one the
  right-click menu path uses) in addition to returning the error result.

**No completion event.** There is no separate `Zotero.Notifier`-style event for
extraction completion — a successful `attach:true` call ends with new attachments
being added to the item via `Zotero.Attachments.importFromFile()`, which already
fires Zotero's own native item-change notifications. If you need a fire-and-forget
pattern instead of awaiting the promise, listen to those rather than a custom event.

**A backend must be reachable.** The hook honours whatever backend the user has
configured (`extensions.estravon.backendUrl` — local or hosted), exactly like the
right-click menu path. If nothing is configured or reachable, `extract()` resolves
`{status:"error", error:"..."}` — it does not make extraction possible without a
backend; see the vanilla backend's [README](../backend/README.md) for the
zero-cost local option (`--backend mineru`, no API key required).

**Stability**: this is a versioned public API (`Zotero.Estravon.apiVersion`,
independent of the plugin's own release version) — breaking changes will come with a
version bump and a deprecation note here, not a silent behaviour change.

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
