# Estravon Plugin — Development

Technical reference for building, packaging, and extending the plugin. For
end-user install/config, see [`README.md`](README.md).

---

## Building from source (proxy file — recommended)

Full cycle per change: edit → restart Zotero. No build step, no UI navigation.

The proxy file is a plain text file in Zotero's `extensions/` directory whose
name is the addon ID and whose content is the absolute path to `src/plugin/`.
Zotero reads plugin files directly from that path on every startup, so what is
on disk is what runs — with no packaging step in between.

**Advantages over installing a built `.xpi` during development:**

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

## Packaging

### What is an `.xpi` file?

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
- `README.md` / `DEVELOPMENT.md` — developer documentation only
- `icons/` — old root-level icons, superseded by `content/icons/`

### What the `zip` command does

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

| Option / argument | Meaning |
|---|---|
| `-r` | **Recursive** — include all files inside any directory argument (`content/`, `locale/`) |
| `../../builds/estravon-0.1.0.xpi` | Output path; the `.xpi` extension is just a name — ZIP format inside |
| `manifest.json bootstrap.js …` | Individual files to include at the **root** of the archive |
| `content/` | Entire directory, included as `content/…` paths inside the archive |
| `locale/` | Entire directory, included as `locale/…` paths inside the archive |

Run `zip` from inside `src/plugin/`, not the project root — otherwise every
path gets prefixed with `src/plugin/` (e.g. `src/plugin/manifest.json`) and
Zotero won't find `manifest.json` at the archive root, rejecting the install.

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

To test a built `.xpi` rather than the proxy file: **Tools → Add-ons** → gear
icon (⚙) → **Install Add-on From File…** → select `builds/estravon-<version>.xpi`
→ restart Zotero.

Public releases are cut via `setup_8f_github.ipynb` §L — see the notebook for
the strip/build/tag/release pipeline (not reproduced here since it also
handles the public-repo split, which is monorepo-internal tooling).

---

## Architecture notes

### `bootstrap.js` lifecycle hooks

Zotero calls four functions on `bootstrap.js` at the appropriate lifecycle
events; `bootstrap.js` itself runs in a sandbox with no `window` or `Zotero`
globals, only the destructured `{ id, version, rootURI }`.

| Hook | Called | Responsibility |
|---|---|---|
| `startup({id, version, rootURI}, reason)` | Plugin enabled, or Zotero starts with it already enabled | Registers chrome resources, loads `pdf-lib` and `estravon.js` via `loadSubScript`, calls `ZoteroMarker.init()` and `addToAllWindows()` |
| `shutdown({id, version, rootURI}, reason)` | Plugin disabled or Zotero shuts down | Must remove all injected DOM elements (`removeFromAllWindows()`), unregister the public `Zotero.Estravon` hook (`unregisterHook()`), and destruct `chromeHandle` — skipping any of these leaks state across disable/enable cycles |
| `onMainWindowLoad({window})` | Each time a main Zotero window opens | Injects per-window UI (`addToWindow(window)`) |
| `onMainWindowUnload({window})` | Each time a main Zotero window closes | Removes per-window UI (`removeFromWindow(window)`) |

`install()` / `uninstall()` are no-ops — preference defaults come from
`prefs.js`, and Zotero handles preference cleanup on uninstall itself.

### XUL menu injection vs. `Zotero.MenuManager`

The context menu item is injected via direct XUL `createElementNS` calls into
`zotero-itemmenu` (`addToWindow()`/`removeFromWindow()` in `estravon.js`), not
via `Zotero.MenuManager.registerMenu()`. Zotero 8 introduced `MenuManager` as a
declarative alternative that auto-unregisters on plugin disable; a future
refactor could switch to it and drop the manual DOM cleanup entirely, but the
manual approach is used today because the `context` object `MenuManager`
provides isn't yet fully documented (specifically, whether it gives sufficient
access to item type and attachments for the visibility logic below).

### Item-type gating

Two independent conditions decide whether the menu item shows on a given item
(see `_onPopupShowing()` in `estravon.js`):
1. Exactly one item selected.
2. The item type is in `SUPPORTED_ITEM_TYPES` **and** it has at least one PDF
   attachment (`attachmentContentType === "application/pdf"`).

`SUPPORTED_ITEM_TYPES` includes two generic, catch-all types — `webpage` and
`document` — alongside the expected bibliographic types. These exist because
Zotero itself uses them as fallback parent types when a saved PDF doesn't get
matched to its "proper" item type: `webpage` is the Connector's fallback when
a page's site translator fails to recognize it (even though what's being
saved is a PDF), and `document` is the default for a local drag-and-drop PDF
when DOI/ISBN recognition fails. The PDF-attachment gate above is what keeps
genuine (non-PDF) Web Page and Document items from showing the menu item.

### Type checking (optional)

`jsconfig.json` enables VS Code's JS type checking (`checkJs: true`) against
JSDoc annotations. It has no runtime effect and isn't packaged into the
`.xpi`. To run it from the command line:

```bash
npx tsc --noEmit -p src/plugin/jsconfig.json
```

---

## The plugin-level hook API — `Zotero.Estravon.extract()`

If you're building a separate Zotero plugin and want to trigger Estravon
extraction programmatically — without reimplementing the backend HTTP contract
or the attach/log-note logic yourself — call the public hook Estravon
registers on the global `Zotero` object while it's active:

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

## Zotero API dependency table

The Zotero API methods the plugin actually calls:

| Method | Where used | What it does |
|---|---|---|
| `Zotero.getMainWindows()` | `addToAllWindows()` | Returns array of all open main Zotero windows |
| `window.ZoteroPane.getSelectedItems()` | `_onPopupShowing()`, `getSelectedItemWithPDF()` | Returns array of currently selected items |
| `item.itemType` | `_onPopupShowing()`, `getSelectedItemWithPDF()` | String: `"book"`, `"bookSection"`, `"journalArticle"`, `"webpage"`, `"document"`, etc. — see `SUPPORTED_ITEM_TYPES` in `estravon.js` for the full set the plugin acts on |
| `item.getAttachments()` | `_onPopupShowing()`, `getSelectedItemWithPDF()` | Returns array of child attachment item IDs |
| `Zotero.Items.get(id)` | `_onPopupShowing()` | Get an item object by its numeric ID |
| `att.attachmentContentType` | `_onPopupShowing()` | MIME type string, e.g. `"application/pdf"` |
| `att.getFilePath()` | `getSelectedItemWithPDF()`, `readPdfBytes()` | Returns absolute path to the attachment file, or `false` |
| `item.getField("title")` | `getSelectedItemWithPDF()` | Get a metadata field value |
| `item.key` | `getSelectedItemWithPDF()` | Short alphanumeric key, e.g. `"ABC12345"` |
| `IOUtils.read(path)` | `readPdfBytes()` | Read a file as `Uint8Array` (Zotero 8+ API) |
| `Zotero.Prefs.get(key)` | `getBackendUrl()` | Read a preference value |
| `Zotero.Prefs.set(key, value)` | preferences.xhtml binding | Write a preference value |
| `Zotero.PreferencePanes.register({...})` | `init()` | Register a preference pane in Settings |
| `Services.prompt.alert(win, title, msg)` | `_showError()`, `_showInfo()` | Show a modal dialog |
| `Services.scriptloader.loadSubScript(url)` | `bootstrap.js` | Load a JS file into the current scope |
| `Zotero.Estravon` registration | `init()` (`bootstrap.js` `startup()`) | Registers the public hook API (see above) on the global `Zotero` object |
| `unregisterHook()` | `bootstrap.js` `shutdown()` | Tears down the `Zotero.Estravon` hook so no other plugin can call into a torn-down instance |
