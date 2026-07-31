// @ts-check

// PLUGIN_BUILD is replaced by scripts/build_xpi.py at package time.
// In development it reads "dev"; in a packaged XPI it is the git SHA +
// ISO timestamp, e.g. "abc1234+2026-05-26T15:01Z".
// This value is sent in the X-Plugin-Version request header so the server
// can log which exact build triggered a given job or error.
const PLUGIN_BUILD = "dev";

// Trim PDFs larger than this before upload. Below the threshold the overhead
// of parsing and rewriting the PDF structure is not worth the bandwidth saving.
const PDF_TRIM_THRESHOLD_BYTES = 30 * 1024 * 1024;  // 30 MB

// Hard limit for uploads without a page range. The server's nginx is configured
// to reject bodies larger than this. Warn the user early rather than showing a
// cryptic HTTP 413 after a long upload.
const PDF_UPLOAD_LIMIT_BYTES = 200 * 1024 * 1024;  // 200 MB

// Version of the public Zotero.Estravon hook API (see extract() below) — independent
// of the plugin's own manifest version, since a plugin patch release should not force
// a hook API bump, and vice versa. Bump this only on a breaking change to extract()'s
// request/response shape, and note it in the README's Developer API section.
const HOOK_API_VERSION = "1.0.0";

/**
 * estravon.js
 * ================
 * Main plugin logic for estravon.
 *
 * This file is loaded by bootstrap.js via Services.scriptloader.loadSubScript().
 * It defines the ZoteroMarker object in the bootstrap sandbox's global scope.
 *
 * Design principles
 * -----------------
 * - All Zotero API access is here. bootstrap.js only calls init/addToAllWindows/
 *   removeFromAllWindows.
 * - All DOM elements injected into Zotero windows are tracked in _addedElements
 *   and removed in removeFromWindow(). No orphan nodes on disable.
 * - Backend communication uses fetch() with the user-configured backend URL.
 *   The plugin never hardcodes "localhost".
 * - All async operations use async/await (native Promise; Zotero 8 removed Bluebird).
 *
 * Type safety
 * -----------
 * This file uses JSDoc annotations checked by VS Code via jsconfig.json.
 * No build step or Node.js is required. The consolidated type definitions
 * below define the data contracts between the plugin and the Python backend.
 *
 * XUL namespace
 * -------------
 * Zotero 8 uses XUL elements for menus. All createElement calls for menu
 * items must use the XUL namespace:
 *   doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "menuitem")
 *
 * Reference plugins
 * -----------------
 * - UB-Mannheim/zotero-ocr: context menu registration, addToWindow/removeFromWindow pattern
 * - llm-for-zotero: agent mode tool registration (future integration target)
 */


// ==========================================================================
// TYPE DEFINITIONS — plugin ↔ backend data contracts
// ==========================================================================

/**
 * Result of GET /ping — backend health check.
 *
 * The backend returns { "status": "ok", "backend": "<name>" }.
 * There is no version field in the /ping response.
 *
 * @typedef {Object} BackendHealthResult
 * @property {boolean} ok          - true if backend responded successfully
 * @property {string}  [backend]   - "replicate" or "datalab" (present when ok)
 * @property {string}  [error]     - error message (present when !ok)
 */

/**
 * Data extracted from the selected Zotero item.
 * Produced by getSelectedItemWithPDF(), consumed by the extraction dialog.
 *
 * @typedef {Object} SelectedItemData
 * @property {any}      item             - Zotero.Item object (parent item)
 * @property {string}   itemType         - "book" | "bookSection" | "journalArticle"
 * @property {string}   itemKey          - short alphanumeric key, e.g. "ABC12345"
 * @property {string}   title            - item title from metadata
 * @property {{title: string, path: string}[]} pdfAttachments - all PDFs on the item
 * @property {string[]} existingSections - e.g. ["chapter_01", "chapter_02"]
 */

/**
 * Immediate response from POST /process on the hosted backend (HTTP 202).
 * The job has been queued; use job_id to poll GET /jobs/{job_id}.
 *
 * @typedef {Object} QueuedResponse
 * @property {"queued"} status
 * @property {string}   job_id          - RQ job ID (different from the pipeline job_id in ProcessResponse)
 * @property {number}   [queue_position] - Number of jobs ahead in the queue at submission time
 * @property {number}   [est_wait_s]     - Estimated wait in seconds based on recent job durations
 */

/**
 * Response from GET /jobs/{job_id} while the job is running or in a terminal state.
 *
 * @typedef {Object} JobPollResponse
 * @property {"queued"|"running"|"done"|"error"|"not_found"} status
 * @property {string} [error]  - present when status is "error"
 */

/**
 * Success response from POST /process (local backend, HTTP 200) or from
 * GET /jobs/{job_id} once status is "done" (hosted backend).
 * Mirrors the Python `process_section()` success return dict from pipeline.py.
 *
 * The backend uses a fail-fast policy: if any chunk fails, the entire job
 * stops immediately and returns a ProcessError (HTTP 500) instead. There is
 * no partial-completion state — status is always "done" on success.
 *
 * Note: on the hosted backend, the job_id here is the pipeline's internal UUID
 * (used in file URLs), NOT the rq_job_id used for polling.
 *
 * @typedef {Object} ProcessResponse
 * @property {"done"}        status    - always "done" on success
 * @property {string}        backend   - "replicate" | "datalab"
 * @property {string}        job_id    - UUID4, used in /files/{job_id}/... URLs
 * @property {ChunkResult[]} files     - one entry per chunk produced
 */

/**
 * Error response from POST /process (HTTP 4xx / 5xx).
 * All backend error paths return this shape.
 *
 * HTTP 409 — {"status":"error", "error":"A job is already running"}
 * HTTP 422 — {"status":"error", "error":"<validation message>"}
 * HTTP 500 — {"status":"error", "error":"<message>", "label":"<chunk>"}
 *            (label is present when a chunk extraction failed mid-job)
 *
 * In M3, check `response.ok` first; only parse as ProcessResponse on HTTP 200.
 *
 * @typedef {Object} ProcessError
 * @property {"error"} status  - always "error" on HTTP 4xx/5xx
 * @property {string}  error   - human-readable error message
 * @property {string}  [label] - chunk label that failed (HTTP 500 only)
 */

/**
 * A single chunk within a ProcessResponse.
 *
 * @typedef {Object} ChunkResult
 * @property {string}      label         - e.g. "chapter_01_a"
 * @property {string}      md_url        - relative URL, e.g. "/files/uuid/chapter_01_a.md"
 * @property {string[]}    image_urls    - relative URLs for extracted images
 * @property {number|null} quality_score - 0–5 (Datalab) or null (Replicate)
 */

/**
 * Form data sent from the extraction dialog to POST /process.
 * Assembled by the dialog (Milestone 3), consumed by the upload function.
 *
 * @typedef {Object} ExtractionRequest
 * @property {Uint8Array}  pdfBytes      - raw PDF file content
 * @property {string}      sectionName   - e.g. "chapter_03"
 * @property {string}      pageRange     - 1-based inclusive, e.g. "14-200"
 * @property {number}      chunkSize     - pages per chunk, e.g. 80
 * @property {"fast"|"balanced"|"accurate"} mode - extraction quality mode
 */

/**
 * Arguments passed to the extraction dialog via window.arguments[0].
 *
 * @typedef {Object} DialogArgs
 * @property {string}   title            - Display title of the Zotero item
 * @property {string}   backend          - Backend name from /ping ("replicate"|"datalab")
 * @property {string}   itemType         - "book" | "bookSection" | "journalArticle" | "conferencePaper" | "report" | "preprint"
 * @property {string[]} existingSections - Existing section names, e.g. ["chapter_01", "table_of_contents"]
 * @property {{title: string, path: string}[]} pdfAttachments - All PDFs on the item
 * @property {number}   defaultChunkSize - Default chunk size from pref
 * @property {string}   defaultMode      - Default mode from pref ("fast"|"balanced"|"accurate")
 * @property {function(DialogFormData): Promise<void>} onExtract - Invoked on Extract click
 */

/**
 * Form data collected by the extraction dialog and passed to onExtract.
 *
 * Named DialogFormData (not FormData) to avoid shadowing the DOM built-in.
 *
 * @typedef {Object} DialogFormData
 * @property {string} sectionName     - e.g. "chapter_01"
 * @property {string} selectedPdfPath - absolute path of the chosen PDF
 * @property {string} pageRange       - e.g. "14-200"
 * @property {number} chunkSize       - pages per chunk
 * @property {"fast"|"balanced"|"accurate"} mode
 * @property {((msg: string) => void)|null} [onProgress] - set by the dialog to update its status label
 * @property {boolean} [createNote]   - when true, create a Zotero note alongside each .md attachment
 * @property {boolean} [forceOcr]     - when true, discard the existing text layer and re-OCR via Surya (patents)
 */

/**
 * Options accepted by the public Zotero.Estravon.extract() hook — lets another Zotero
 * plugin trigger extraction through the installed Estravon plugin, without knowing
 * backend HTTP details or re-implementing the attach/log-note logic itself.
 *
 * Unlike DialogFormData (collected from the extraction dialog by a human), this is
 * assembled programmatically by another Zotero plugin, so item/attachment are
 * resolved from IDs rather than from the current UI selection.
 *
 * @typedef {Object} HookExtractOptions
 * @property {number}  itemID            - Zotero item ID to attach results to
 * @property {number}  [pdfAttachmentID] - Specific PDF attachment ID; if omitted, the
 *   item's first PDF attachment in attachment order is used
 * @property {string}  pageRange         - 1-based inclusive, e.g. "14-200"
 * @property {string}  sectionName       - Label for the result + log note
 * @property {"fast"|"balanced"|"accurate"} [mode] - default from prefs
 * @property {number}  [chunkSize]       - default from prefs
 * @property {boolean} [forceOcr=false]
 * @property {boolean} [attach=true]     - true: attach .md + write log note (full
 *   plugin behaviour); false: resolve with markdown only, caller handles filing
 * @property {boolean} [silent=true]     - false: also show Estravon's own error dialog
 *   on failure. Defaults to true so a caller triggering extraction in the background
 *   never gets an unsolicited modal dialog in the user's Zotero window; a caller
 *   invoking this from its own UI can opt in to Estravon's dialog with silent:false.
 */

/**
 * Result of Zotero.Estravon.extract(). Always resolves — never rejects — so callers
 * get a predictable shape rather than needing a try/catch around every call.
 *
 * @typedef {Object} HookExtractResult
 * @property {"done"|"error"} status
 * @property {string}   [jobId]
 * @property {{label: string, markdown: string}[]} [markdown] - present when attach:false
 * @property {number[]} [attachmentIDs] - present when attach:true (the .md attachments'
 *   Zotero item IDs, not the image attachments)
 * @property {string}   [error] - present when status is "error"
 */

/**
 * One extractable section on a Zotero item — a .md attachment.
 *
 * @typedef {Object} SectionEntry
 * @property {string} filename - e.g. "chapter_01.md"  (from att.getDisplayTitle())
 * @property {string} label    - e.g. "chapter_01"     (filename stem, no extension)
 */

/**
 * Arguments passed to the workspace picker dialog via window.arguments[0].
 *
 * @typedef {Object} WorkspaceDialogArgs
 * @property {string}         itemTitle  - Display title of the selected Zotero item
 * @property {string}         rootPath   - Absolute path to the workspacesRoot folder
 * @property {string[]}       workspaces - Sorted names of existing workspace subdirs
 * @property {string}         bookSlug   - Slugified item title used for the book subfolder
 * @property {SectionEntry[]} sections   - All .md attachments on the item, in attachment order
 * @property {function(string, string[]): Promise<void>} onConfirm
 *   Called with (workspacePath, selectedFilenames[]) when the user clicks Export.
 *   selectedFilenames contains the .md filenames the user chose (e.g. ["chapter_01.md"]).
 */

// ==========================================================================
// END TYPE DEFINITIONS
// ==========================================================================


const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/** Item types for which the "Extract Section to Markdown…" menu item is shown. */
const SUPPORTED_ITEM_TYPES = new Set([
    "book", "bookSection",
    "journalArticle", "conferencePaper", "report", "preprint",
    "patent",
]);


// ==========================================================================
// MARKDOWN ↔ HTML CONVERTERS
// Pure module-level functions — no Zotero API, no `this` dependency.
// ==========================================================================

/** @param {string} t @returns {string} */
function _zmEscapeHtml(t) {
    return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** @param {string} t @returns {string} */
function _zmUnescapeHtml(t) {
    return t
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

/** @param {string} h @returns {string} */
function _zmStripTags(h) { return h.replace(/<[^>]+>/g, ""); }

/**
 * Convert inline markdown (bold, italic, code, links) to HTML.
 * Extracts code spans first so their content is not processed as markdown.
 * @param {string} text
 * @returns {string}
 */
function _zmInlineMd(text) {
    /** @type {string[]} */
    let codes = [];
    text = text.replace(/`([^`]+)`/g, (_, code) => {
        codes.push(_zmEscapeHtml(code));
        return "\x01" + (codes.length - 1) + "\x01";
    });
    text = _zmEscapeHtml(text);
    text = text.replace(/\*\*([^*\x01]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_\x01]+)__/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*\x01]+)\*/g, "<em>$1</em>");
    text = text.replace(/_([^_\x01]+)_/g, "<em>$1</em>");
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    text = text.replace(/\x01(\d+)\x01/g, (_, n) => "<code>" + codes[+n] + "</code>");
    return text;
}

/**
 * Convert inline HTML (bold, italic, code, links) to markdown.
 * @param {string} h
 * @returns {string}
 */
function _zmInlineHtmlToMd(h) {
    h = h.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
    h = h.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
    h = h.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_");
    h = h.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_");
    h = h.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
    h = h.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
    return h;
}

/**
 * Convert Marker-output markdown to Zotero-compatible HTML.
 *
 * Pre-processes Zotero-internal image links (../KEY8CHAR/file.jpg) into
 * [Image: file.jpg] placeholders before conversion, since Zotero notes
 * cannot reference sibling attachments by relative path.
 * Also strips the <!-- estravon ... --> provenance footer.
 *
 * @param {string} markdown
 * @returns {string} HTML string suitable for Zotero.Item.setNote()
 */
function markdownToNoteHtml(markdown) {
    let text = markdown
        .replace(/!\[([^\]]*)\]\(\.\.\/[A-Z0-9]{8}\/([^)]+)\)/g, "[Image: $2]")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => "[Image" + (alt ? ": " + alt : "") + "]")
        .replace(/<!--\s*estravon[\s\S]*?-->/g, "")
        .trim();

    let lines = text.split("\n");
    let out = "";
    let i = 0;

    while (i < lines.length) {
        let line = lines[i];

        // Fenced code block
        let fenceM = /^(`{3,}|~{3,})(.*)/.exec(line);
        if (fenceM) {
            let fence = fenceM[1], lang = fenceM[2].trim();
            let codeLines = [];
            i++;
            while (i < lines.length && !lines[i].startsWith(fence)) { codeLines.push(lines[i++]); }
            out += "<pre><code" + (lang ? ' class="language-' + lang + '"' : "") + ">" +
                   _zmEscapeHtml(codeLines.join("\n")) + "</code></pre>\n";
            i++; // closing fence
            continue;
        }

        // Heading
        let hM = /^(#{1,6}) (.+)/.exec(line);
        if (hM) {
            let lvl = hM[1].length;
            out += "<h" + lvl + ">" + _zmInlineMd(hM[2].trim()) + "</h" + lvl + ">\n";
            i++; continue;
        }

        // Horizontal rule
        if (/^[-*_]{3,}\s*$/.test(line)) { out += "<hr/>\n"; i++; continue; }

        // Blockquote
        if (/^> /.test(line)) {
            let bq = [];
            while (i < lines.length && /^>/.test(lines[i])) { bq.push(lines[i++].replace(/^> ?/, "")); }
            out += "<blockquote><p>" + _zmInlineMd(bq.join(" ").trim()) + "</p></blockquote>\n";
            continue;
        }

        // Unordered list
        if (/^[*+-] /.test(line)) {
            out += "<ul>\n";
            while (i < lines.length && /^[*+-] /.test(lines[i])) {
                out += "<li>" + _zmInlineMd(lines[i++].replace(/^[*+-] /, "")) + "</li>\n";
            }
            out += "</ul>\n"; continue;
        }

        // Ordered list
        if (/^\d+\. /.test(line)) {
            out += "<ol>\n";
            while (i < lines.length && /^\d+\. /.test(lines[i])) {
                out += "<li>" + _zmInlineMd(lines[i++].replace(/^\d+\. /, "")) + "</li>\n";
            }
            out += "</ol>\n"; continue;
        }

        // Table (GFM)
        if (/^\|/.test(line) && i + 1 < lines.length && /^\|[-| :]+\|$/.test(lines[i + 1])) {
            let headers = line.split("|").slice(1, -1).map(s => s.trim());
            let aligns  = lines[i + 1].split("|").slice(1, -1).map(s => {
                s = s.trim();
                return /^:-+:$/.test(s) ? "center" : /:$/.test(s) ? "right" : "";
            });
            i += 2;
            out += "<table><thead><tr>";
            headers.forEach((h, j) => {
                out += "<th" + (aligns[j] ? ' align="' + aligns[j] + '"' : "") + ">" + _zmInlineMd(h) + "</th>";
            });
            out += "</tr></thead><tbody>\n";
            while (i < lines.length && /^\|/.test(lines[i])) {
                let cells = lines[i++].split("|").slice(1, -1).map(s => s.trim());
                out += "<tr>";
                cells.forEach((c, j) => {
                    out += "<td" + (aligns[j] ? ' align="' + aligns[j] + '"' : "") + ">" + _zmInlineMd(c) + "</td>";
                });
                out += "</tr>\n";
            }
            out += "</tbody></table>\n"; continue;
        }

        // Empty line
        if (/^\s*$/.test(line)) { i++; continue; }

        // Paragraph — collect until blank or a block-start pattern
        let paraLines = [];
        while (i < lines.length &&
               !/^\s*$/.test(lines[i]) &&
               !/^(#{1,6} |[*+-] |\d+\. |> |`{3}|~{3}|[-*_]{3,}\s*$|\|)/.test(lines[i])) {
            paraLines.push(lines[i++]);
        }
        if (paraLines.length > 0) {
            out += "<p>" + _zmInlineMd(paraLines.join(" ").trim()) + "</p>\n";
        }
    }

    return out;
}

/**
 * Convert a Zotero note's HTML content to markdown.
 *
 * Handles: headings, code blocks, lists, tables, blockquotes, paragraphs,
 * horizontal rules, inline bold/italic/code/links. Uses regex-based conversion
 * that works in Zotero's bootstrap sandbox without DOMParser.
 *
 * @param {string} html
 * @returns {string} markdown text
 */
function noteHtmlToMarkdown(html) {
    let text = html;

    // Code blocks (before inline code so <pre><code> isn't double-processed)
    text = text.replace(
        /<pre[^>]*><code[^>]*class="language-([^"]+)"[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
        (_, lang, code) => "```" + lang + "\n" + _zmUnescapeHtml(code) + "\n```\n\n");
    text = text.replace(
        /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
        (_, code) => "```\n" + _zmUnescapeHtml(code) + "\n```\n\n");

    // Headings (h6 → h1 so longer tags match before shorter prefixes)
    for (let lvl = 6; lvl >= 1; lvl--) {
        text = text.replace(
            new RegExp("<h" + lvl + "[^>]*>([\\s\\S]*?)<\\/h" + lvl + ">", "gi"),
            (_, c) => "#".repeat(lvl) + " " + _zmStripTags(c).trim() + "\n\n");
    }

    // Lists — use exec loop to avoid implicit-any in nested replace callbacks
    text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, ulContent) => {
        let out = "";
        let re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let m;
        while ((m = re.exec(ulContent)) !== null) {
            out += "- " + _zmStripTags(_zmInlineHtmlToMd(m[1] || "")).trim() + "\n";
        }
        return out + "\n";
    });
    text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, olContent) => {
        let out = "";
        let n = 0;
        let re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let m;
        while ((m = re.exec(olContent)) !== null) {
            out += ++n + ". " + _zmStripTags(_zmInlineHtmlToMd(m[1] || "")).trim() + "\n";
        }
        return out + "\n";
    });

    // Tables
    text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tc) => {
        let rows = [];
        let thM = tc.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
        let tbM = tc.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
        if (thM) {
            let cells = [...thM[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
                .map(m => _zmStripTags(_zmInlineHtmlToMd(m[1])).trim().replace(/\|/g, "\\|"));
            rows.push("| " + cells.join(" | ") + " |");
            rows.push("| " + cells.map(() => "---").join(" | ") + " |");
        }
        if (tbM) {
            for (let rowM of tbM[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
                let cells = [...rowM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
                    .map(m => _zmStripTags(_zmInlineHtmlToMd(m[1])).trim().replace(/\|/g, "\\|"));
                rows.push("| " + cells.join(" | ") + " |");
            }
        }
        return rows.join("\n") + "\n\n";
    });

    // Blockquotes
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
        (_, c) => "> " + _zmStripTags(c).trim().replace(/\n+/g, "\n> ") + "\n\n");

    // Paragraphs
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi,
        (_, c) => _zmStripTags(_zmInlineHtmlToMd(c)).trim() + "\n\n");

    // Horizontal rule
    text = text.replace(/<hr[^>]*\/?>/gi, "---\n\n");

    // Line breaks
    text = text.replace(/<br[^>]*\/?>/gi, "\n");

    // Any remaining inline formatting outside block elements
    text = _zmInlineHtmlToMd(text);

    // Strip remaining tags, unescape entities, normalize whitespace
    text = _zmUnescapeHtml(_zmStripTags(text));
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    return text;
}


var ZoteroMarker = {

    // -----------------------------------------------------------------------
    // Internal state
    // -----------------------------------------------------------------------

    /**
     * Plugin metadata, set by init().
     * @type {{ id: string, version: string, rootURI: string }}
     */
    _meta: null,

    /**
     * Tracks DOM elements injected into each window for cleanup.
     * Key: window object. Value: array of DOM Element references.
     * @type {Map<Window, Element[]>}
     */
    _addedElements: new Map(),


    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Initialise the plugin. Called once from bootstrap.js startup().
     *
     * @param {object} meta - { id, version, rootURI }
     */
    init(meta) {
        this._meta = meta;

        Zotero.PreferencePanes.register({
            pluginID: meta.id,
            label: "Estravon",
            src: meta.rootURI + "content/preferences.xhtml",
            scripts: [meta.rootURI + "content/preferences.js"],
        }).catch(e => {
            Zotero.debug("[estravon] PreferencePanes.register failed: " + e);
        });

        // Public extraction hook for other Zotero plugins — registered here (not in
        // bootstrap.js) so it lives alongside the other Zotero.* registration above and
        // bootstrap.js stays lifecycle-glue-only. Unregistered in unregisterHook(),
        // called from bootstrap.js shutdown() — see that function for why (avoids
        // leaving a dangling Zotero.Estravon another plugin could call into after this
        // plugin has torn down). See README.md's "Developer API" section for the
        // full extract() contract this exposes.
        Zotero.Estravon = {
            apiVersion: HOOK_API_VERSION,
            extract: (/** @type {HookExtractOptions} */ options) => this.extract(options),
        };

        // First-install onboarding: open the "Get started" page once.
        // Uses a pref so it fires exactly once, regardless of how the plugin
        // was installed or re-enabled.
        let firstLaunchDone = Zotero.Prefs.get("extensions.estravon.firstLaunchDone", true);
        if (!firstLaunchDone) {
            Zotero.Prefs.set("extensions.estravon.firstLaunchDone", true, true);
            Zotero.uiReadyPromise.then(() => {
                try {
                    Zotero.launchURL("https://estravon.com/start");
                } catch (e) {
                    Zotero.debug("[estravon] First-launch URL open failed: " + e);
                }
            });
        }

        Zotero.debug("[estravon] Initialised v" + meta.version);
    },

    /**
     * Inject UI elements into all currently open Zotero windows.
     * Also registers a window listener for windows opened after startup.
     */
    addToAllWindows() {
        var windows = Zotero.getMainWindows();
        for (let win of windows) {
            if (win.ZoteroPane) {
                this.addToWindow(win);
            }
        }
    },

    /**
     * Inject the right-click context menu item into a single Zotero window.
     *
     * Supported item types (SUPPORTED_ITEM_TYPES):
     *   "book", "bookSection", "journalArticle"
     *
     * Note — Zotero 8 MenuManager alternative
     * -----------------------------------------
     * Zotero 8 introduced `Zotero.MenuManager.registerMenu()`, a declarative API
     * that auto-unregisters on plugin disable. If the `context` object it provides
     * gives sufficient access to item type and attachments, a future refactor could
     * replace addToWindow/removeFromWindow with a single MenuManager call and remove
     * the _addedElements cleanup mechanism entirely. For now the manual DOM approach
     * is used because the MenuManager context API is not yet fully documented.
     *
     * @param {Window} window - A Zotero main window
     */
    addToWindow(window) {
        Zotero.debug("[estravon] addToWindow called");
        let doc = window.document;
        let menu = doc.getElementById("zotero-itemmenu");
        if (!menu) {
            Zotero.debug("[estravon] addToWindow: zotero-itemmenu not found");
            return;
        }

        let elements = [];

        // --- Separator ---
        let sep = doc.createElementNS(XUL_NS, "menuseparator");
        sep.id = "estravon-separator";
        menu.appendChild(sep);
        elements.push(sep);

        // --- Menu item ---
        let menuitem = doc.createElementNS(XUL_NS, "menuitem");
        menuitem.id = "estravon-extract";
        menuitem.setAttribute("label", "Extract Section to Markdown\u2026");
        menuitem.setAttribute("class", "menuitem-iconic");
        menuitem.setAttribute("image", "chrome://estravon/content/icons/marker-icon.png");
        // Hidden by default; visibility controlled by onPopupShowing
        menuitem.hidden = true;
        menuitem.addEventListener("command", () => {
            this.onMenuItemCommand(window);
        });
        menu.appendChild(menuitem);
        elements.push(menuitem);

        // --- Export to Workspace menu item ---
        // Visible only when the item already has .md attachments (sections extracted).
        let exportItem = doc.createElementNS(XUL_NS, "menuitem");
        exportItem.id = "estravon-export";
        exportItem.setAttribute("label", "Export to Workspace\u2026");
        exportItem.setAttribute("class", "menuitem-iconic");
        exportItem.setAttribute("image", "chrome://estravon/content/icons/marker-icon.png");
        exportItem.hidden = true;
        exportItem.addEventListener("command", () => {
            this.onExportMenuItemCommand(window);
        });
        menu.appendChild(exportItem);
        elements.push(exportItem);

        // --- Separator between extract/export group and convert group ---
        let convertSep = doc.createElementNS(XUL_NS, "menuseparator");
        convertSep.id = "estravon-convert-separator";
        convertSep.hidden = true;
        menu.appendChild(convertSep);
        elements.push(convertSep);

        // --- "Convert to Zotero note" — shown on .md attachment items ---
        let mdToNoteItem = doc.createElementNS(XUL_NS, "menuitem");
        mdToNoteItem.id = "estravon-md-to-note";
        mdToNoteItem.setAttribute("label", "Convert to Zotero note");
        mdToNoteItem.hidden = true;
        mdToNoteItem.addEventListener("command", () => {
            this.convertMdToNote(window).catch(e => {
                this._showError(window, "Conversion failed", String(e), e instanceof Error ? e : null);
            });
        });
        menu.appendChild(mdToNoteItem);
        elements.push(mdToNoteItem);

        // --- "Convert to Markdown file" — shown on child note items ---
        let noteToMdItem = doc.createElementNS(XUL_NS, "menuitem");
        noteToMdItem.id = "estravon-note-to-md";
        noteToMdItem.setAttribute("label", "Convert to Markdown file");
        noteToMdItem.hidden = true;
        noteToMdItem.addEventListener("command", () => {
            this.convertNoteToMd(window).catch(e => {
                this._showError(window, "Conversion failed", String(e), e instanceof Error ? e : null);
            });
        });
        menu.appendChild(noteToMdItem);
        elements.push(noteToMdItem);

        // --- Popup showing listener ---
        let popupListener = () => { this._onPopupShowing(window); };
        menu.addEventListener("popupshowing", popupListener);

        // Store listener reference for cleanup
        menuitem._zmPopupListener = popupListener;
        menuitem._zmMenu = menu;

        // Track all injected elements for cleanup
        this._addedElements.set(window, elements);

        Zotero.debug("[estravon] Added menu items to window");
    },

    /**
     * Remove all injected DOM elements from a single Zotero window.
     *
     * @param {Window} window - A Zotero main window
     */
    removeFromWindow(window) {
        let elements = this._addedElements.get(window);
        if (!elements) return;

        for (let el of elements) {
            if (el._zmPopupListener && el._zmMenu) {
                el._zmMenu.removeEventListener("popupshowing", el._zmPopupListener);
            }
            el.remove();
        }

        this._addedElements.delete(window);
        Zotero.debug("[estravon] Removed menu items from window");
    },

    /**
     * Remove UI from all windows. Called by bootstrap.js shutdown().
     */
    removeFromAllWindows() {
        var windows = Zotero.getMainWindows();
        for (let win of windows) {
            this.removeFromWindow(win);
        }
    },

    /**
     * Unregister the public Zotero.Estravon hook. Called by bootstrap.js shutdown(),
     * mirroring the chromeHandle.destruct() discipline already used there — a plugin
     * disable/uninstall must not leave a dangling Zotero.Estravon another plugin could
     * still call into after this plugin has torn down.
     */
    unregisterHook() {
        if (typeof Zotero !== "undefined" && Zotero.Estravon) {
            delete Zotero.Estravon;
        }
    },


    // -----------------------------------------------------------------------
    // Menu visibility
    // -----------------------------------------------------------------------

    /**
     * Called every time the item context menu opens. Controls whether the
     * "Extract Section to Markdown…" menu item is visible.
     *
     * Visibility rules:
     * 1. Exactly one item must be selected.
     * 2. The item type must be in SUPPORTED_ITEM_TYPES ("book", "bookSection",
     *    "journalArticle", "conferencePaper", "report", "preprint", "patent").
     * 3. The item must have at least one PDF attachment.
     *
     * @param {Window} window - The Zotero window where the menu opened
     * @private
     */
    _onPopupShowing(window) {
        let doc = window.document;
        let sep         = doc.getElementById("estravon-separator");
        let extractItem = doc.getElementById("estravon-extract");
        let exportItem  = doc.getElementById("estravon-export");
        let convertSep  = doc.getElementById("estravon-convert-separator");
        let mdToNoteItem = doc.getElementById("estravon-md-to-note");
        let noteToMdItem = doc.getElementById("estravon-note-to-md");
        if (!sep || !extractItem) return;

        let showExtract       = false;
        let showExport        = false;
        let showConvertToNote = false;
        let showConvertToMd   = false;

        try {
            let zoteroPane = window.ZoteroPane;
            let items = zoteroPane.getSelectedItems();

            if (items.length === 1) {
                let item = items[0];

                // Extract/Tools/Export — only for supported parent item types
                if (SUPPORTED_ITEM_TYPES.has(item.itemType)) {
                    let attachmentIDs = item.getAttachments();
                    for (let id of attachmentIDs) {
                        let att = Zotero.Items.get(id);
                        if (!att) continue;
                        if (att.attachmentContentType === "application/pdf") {
                            showExtract = true;
                        }
                        if (att.attachmentContentType === "text/plain" &&
                                (att.getDisplayTitle() || "").endsWith(".md")) {
                            showExport = true;
                        }
                    }
                }

                // "Convert to Zotero note" — shown on .md file attachment items
                if (item.isAttachment() &&
                        item.attachmentContentType === "text/plain" &&
                        (item.getDisplayTitle() || "").endsWith(".md")) {
                    showConvertToNote = true;
                }

                // "Convert to Markdown file" — shown on child notes that are NOT the extraction log
                if (item.isNote() && item.parentID) {
                    if (!item.getNote().includes("<h2>[estravon] Extraction log</h2>")) {
                        showConvertToMd = true;
                    }
                }
            }
        } catch (e) {
            Zotero.debug("[estravon] Error in _onPopupShowing: " + e);
        }

        let showConvert = showConvertToNote || showConvertToMd;
        let showAny     = showExtract || showExport || showConvert;
        sep.hidden             = !showAny;
        extractItem.hidden     = !showExtract;
        if (exportItem)  exportItem.hidden  = !showExport;
        // Convert separator only when both groups are visible simultaneously
        if (convertSep)  convertSep.hidden  = !(showConvert && (showExtract || showExport));
        if (mdToNoteItem) mdToNoteItem.hidden = !showConvertToNote;
        if (noteToMdItem) noteToMdItem.hidden = !showConvertToMd;
    },


    // -----------------------------------------------------------------------
    // Item data access
    // -----------------------------------------------------------------------

    /**
     * Read the selected item and its PDF attachment from the Zotero API.
     *
     * Returns a structured object with all the data the extraction dialog
     * needs to display and the backend needs to receive.
     *
     * @param {Window} window - The Zotero window
     * @returns {Promise<SelectedItemData|null>} Item data, or null if selection invalid.
     */
    async getSelectedItemWithPDF(window) {
        let zoteroPane = window.ZoteroPane;
        let items = zoteroPane.getSelectedItems();

        if (items.length !== 1) return null;
        let item = items[0];
        if (!SUPPORTED_ITEM_TYPES.has(item.itemType)) return null;

        // Find ALL PDF attachments on this item
        let pdfAttachments = [];
        let attachmentIDs = item.getAttachments();
        for (let id of attachmentIDs) {
            let att = Zotero.Items.get(id);
            if (att && att.attachmentContentType === "application/pdf") {
                let pdfPath = await att.getFilePath();
                if (pdfPath) {
                    pdfAttachments.push({
                        title: att.getField("title") || att.attachmentFilename || "unknown.pdf",
                        path:  pdfPath,
                    });
                }
            }
        }
        if (pdfAttachments.length === 0) return null;

        let existingSections = await this.getExistingSections(item);

        return {
            item,
            itemType: item.itemType,
            itemKey:  item.key,
            title:    item.getField("title"),
            pdfAttachments,   // [{title, path}, ...]
            existingSections,
        };
    },

    /**
     * Resolve a Zotero item and PDF attachment path from bare IDs, for the public
     * Zotero.Estravon.extract() hook.
     *
     * Deliberately separate from getSelectedItemWithPDF() above: that function reads
     * the *current UI selection* via window.ZoteroPane, which has no meaning for a
     * programmatic call from another plugin — a hook caller supplies itemID directly
     * instead.
     *
     * @param {number} itemID
     * @param {number} [pdfAttachmentID] - specific PDF attachment; if omitted, the
     *   first PDF attachment in attachment order is used — there's no dialog here for
     *   the caller to pick from the way the menu path has, so a deterministic default
     *   was chosen over rejecting outright when an item has more than one PDF.
     * @returns {Promise<{item: any, pdfPath: string, itemKey: string}>}
     * @throws {Error} If the item doesn't exist, has no PDF attachment, the given
     *   pdfAttachmentID isn't a PDF attachment of that item, or the PDF isn't on disk.
     */
    async _resolveItemAndPdf(itemID, pdfAttachmentID) {
        let item = Zotero.Items.get(itemID);
        if (!item) {
            throw new Error(`No Zotero item with ID ${itemID}`);
        }

        let att = null;
        if (pdfAttachmentID) {
            att = Zotero.Items.get(pdfAttachmentID);
            if (!att || att.attachmentContentType !== "application/pdf" || att.parentID !== item.id) {
                throw new Error(`Attachment ${pdfAttachmentID} is not a PDF attachment of item ${itemID}`);
            }
        } else {
            // First PDF attachment in attachment order — see the JSDoc above for why.
            for (let id of item.getAttachments()) {
                let candidate = Zotero.Items.get(id);
                if (candidate && candidate.attachmentContentType === "application/pdf") {
                    att = candidate;
                    break;
                }
            }
            if (!att) {
                throw new Error(`Item ${itemID} has no PDF attachment`);
            }
        }

        let pdfPath = await att.getFilePath();
        if (!pdfPath) {
            throw new Error("PDF file not available on disk. Is it synced?");
        }

        return { item, pdfPath, itemKey: item.key };
    },

    /**
     * List the names of existing .md attachments on the given item.
     *
     * @param {any} item - The parent item (book, bookSection, or journalArticle)
     * @returns {Promise<string[]>} Unique section names, e.g. ["chapter_01", "chapter_02"]
     */
    async getExistingSections(item) {
        let sections = new Set();
        let attachmentIDs = item.getAttachments();

        for (let id of attachmentIDs) {
            let att = Zotero.Items.get(id);
            if (!att) continue;

            let title = att.getField("title") || "";
            if (title.endsWith(".md")) {
                let name = title.slice(0, -3);
                // Strip chunk suffix (_a, _b, … _aa, _ab, …)
                let base = name.replace(/_[a-z]+$/, "");
                sections.add(base);
            }
        }

        return Array.from(sections).sort();
    },

    /**
     * Read the PDF file bytes into a Uint8Array.
     *
     * Uses IOUtils.read() (Zotero 8+ API). The bytes are uploaded to the
     * backend as a multipart file in Milestone 3.
     *
     * @param {any} attachment - A PDF attachment item
     * @returns {Promise<Uint8Array>} Raw PDF bytes
     */
    async readPdfBytes(attachment) {
        let path = await attachment.getFilePath();
        if (!path) {
            throw new Error("PDF file not available on disk. Is it synced?");
        }
        return await IOUtils.read(path);
    },

    /**
     * Trim a PDF to contain only the pages in the given 1-based range.
     *
     * Uses pdf-lib (vendored in lib/pdf-lib.min.js, loaded by bootstrap.js).
     * Runs entirely in-process — the trimmed bytes never touch Zotero storage.
     *
     * @param {Uint8Array} pdfBytes - Full PDF bytes from IOUtils.read()
     * @param {number} startPage    - 1-based start page (inclusive)
     * @param {number} endPage      - 1-based end page (inclusive)
     * @returns {Promise<{trimmedBytes: Uint8Array, pageCount: number}>}
     * @throws {Error} If pdf-lib cannot parse the PDF (encrypted, corrupt, etc.)
     */
    async trimPdfToPageRange(pdfBytes, startPage, endPage) {
        // PDFLib is loaded by bootstrap.js; fall back to globalThis in case the
        // UMD wrapper placed it there instead of the sandbox scope.
        const _lib = (typeof PDFLib !== 'undefined' ? PDFLib : null)
                  || ((typeof globalThis !== 'undefined') ? (/** @type {any} */ (globalThis)).PDFLib : null);
        if (!_lib) throw new Error("pdf-lib not loaded — PDF trimming unavailable");
        const { PDFDocument } = _lib;

        // IOUtils.read() returns a Uint8Array from Zotero's sandbox realm. pdf-lib lives
        // in globalThis's realm. Firefox Xray wrappers make cross-realm instanceof fail,
        // so pdf-lib rejects the bytes as an unknown type.
        // Fix: wrap the same underlying buffer with globalThis's Uint8Array constructor
        // so pdf-lib's `instanceof Uint8Array` check passes. Zero-copy.
        const _GT = /** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis : self);
        const safeBytes = new _GT.Uint8Array(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength);

        // ignoreEncryption: allow some protected PDFs that have no password
        const srcDoc = await PDFDocument.load(safeBytes, { ignoreEncryption: true });
        const totalPages = srcDoc.getPageCount();

        if (startPage < 1 || endPage > totalPages || startPage > endPage) {
            throw new Error(
                `Page range ${startPage}-${endPage} invalid for ${totalPages}-page PDF`
            );
        }

        const pageIndices = [];
        for (let i = startPage - 1; i < endPage; i++) {
            pageIndices.push(i);
        }

        const newDoc = await PDFDocument.create();
        const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
        copiedPages.forEach(page => newDoc.addPage(page));

        const trimmed = await newDoc.save();
        return {
            trimmedBytes: new Uint8Array(trimmed),
            pageCount:    copiedPages.length,
        };
    },

    /**
     * Fire-and-forget session close for a completed job.
     * Sends plugin timing marks and session counters to POST /jobs/{id}/ack.
     * Failures are silently swallowed — ack delivery is best-effort.
     *
     * @param {string} jobId
     * @param {{ submitDoneAt: number|null, firstPollAt: number|null,
     *            resultReceivedAt: number|null, pollCount: number,
     *            errorCount: number }} session
     */
    async _sendAck(jobId, session) {
        const toISO = ms => ms ? new Date(ms).toISOString() : null;
        const payload = {
            plugin_timing: {
                submit_at:        toISO(session.submitDoneAt),
                first_poll_at:    toISO(session.firstPollAt),
                done_received_at: toISO(session.resultReceivedAt),
                ack_sent_at:      new Date().toISOString(),
            },
            plugin_session: {
                plugin_version:  PLUGIN_BUILD,
                total_polls:     session.pollCount,
                errors_received: session.errorCount,
            },
        };
        try {
            await fetch(`${this.getBackendUrl()}/jobs/${jobId}/ack`, {
                method:  "POST",
                headers: { ...this._backendHeaders(), "Content-Type": "application/json" },
                body:    JSON.stringify(payload),
            });
            Zotero.debug("[estravon] /ack sent for job " + jobId);
        } catch (e) {
            Zotero.debug("[estravon] /ack failed (non-fatal): " + e.message);
        }
    },


    // -----------------------------------------------------------------------
    // Backend communication
    // -----------------------------------------------------------------------

    /**
     * Get the backend URL from user preferences.
     *
     * @returns {string} Backend URL, e.g. "http://localhost:7766"
     */
    getBackendUrl() {
        return Zotero.Prefs.get("extensions.estravon.backendUrl", true)
            || "http://localhost:7766";
    },

    /**
     * Get the API key from user preferences.
     * Returns empty string for local/unauthenticated deployments.
     * @returns {string}
     */
    getApiKey() {
        return (Zotero.Prefs.get("extensions.estravon.apiKey", true) || "").trim();
    },

    /**
     * Build auth headers for requests to the hosted backend.
     * Always includes X-Plugin-Version so the server can log which exact
     * plugin build triggered a job or error — critical for debugging user reports.
     * @returns {Record<string, string>}
     */
    _backendHeaders() {
        /** @type {Record<string, string>} */
        let headers = {};
        let key = this.getApiKey();
        if (key) headers["X-API-Key"] = key;
        let version = (this._meta && this._meta.version) ? this._meta.version : "?";
        headers["X-Plugin-Version"] = version + "+" + PLUGIN_BUILD;
        return headers;
    },

    /**
     * Poll GET /jobs/{job_id} until the job reaches a terminal state.
     *
     * Used when POST /process returns 202 (hosted backend async queue).
     * Progressive backoff: every 3 s for the first 60 s, then every 10 s.
     * Gives up after 960 s (16 min — slightly above the server's job_timeout=900).
     *
     * @param {string} job_id - RQ job ID from the 202 response
     * @param {((msg: string) => void)|null} [onProgress] - called with a status string on each poll
     * @returns {Promise<ProcessResponse>}
     */
    async pollJobResult(job_id, onProgress = null, _session = null) {
        const FAST_INTERVAL_MS = 3000;
        const SLOW_INTERVAL_MS = 10000;
        const SWITCH_AT_MS     = 60000;
        const MAX_WAIT_MS      = 960000;

        let elapsed = 0;

        while (true) {
            if (_session) {
                _session.pollCount++;
                if (!_session.firstPollAt) _session.firstPollAt = Date.now();
            }
            let pollResp;
            try {
                let pollUrl = this.getBackendUrl() + "/jobs/" + job_id;
                if (_session) pollUrl += "?poll_n=" + _session.pollCount;
                pollResp = await fetch(pollUrl, {
                    headers: this._backendHeaders(),
                });
            } catch (netErr) {
                if (_session) _session.errorCount++;
                throw new Error("Network error polling job status: " +
                    (netErr instanceof Error ? netErr.message : String(netErr)));
            }
            if (!pollResp.ok && _session) _session.errorCount++;

            /** @type {JobPollResponse} */
            let data;
            try { data = await pollResp.json(); } catch (_) {
                data = { status: "error", error: "Invalid JSON from /jobs/" + job_id };
            }

            let state = data.status || "unknown";

            if (state === "done") {
                if (onProgress) onProgress("Done.");
                return /** @type {ProcessResponse} */ (/** @type {any} */ (data));
            }
            if (state === "error") {
                throw new Error("Extraction failed on server: " + (data.error || "unknown error"));
            }
            if (state === "not_found") {
                throw new Error("Job result not found — it may have expired. Please retry.");
            }

            // still queued or running — update status label and wait
            let elapsedSec = Math.round(elapsed / 1000);
            let statusStr = state === "running"
                ? "Processing… (" + elapsedSec + "s elapsed)"
                : "Queued — waiting for a worker… (" + elapsedSec + "s)";
            if (onProgress) onProgress(statusStr);

            if (elapsed >= MAX_WAIT_MS) {
                throw new Error(
                    "Extraction timed out after 16 minutes. " +
                    "The server may be overloaded — check the dashboard for job status."
                );
            }

            let interval = elapsed < SWITCH_AT_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
            await new Promise(res => setTimeout(res, interval));
            elapsed += interval;
        }
    },

    /**
     * Check backend health by calling GET /ping.
     *
     * The /ping endpoint returns:
     *   { "status": "ok", "backend": "replicate" }
     *
     * Timeout: 5 seconds.
     *
     * @returns {Promise<BackendHealthResult>}
     */
    async checkBackendHealth() {
        let url = this.getBackendUrl() + "/ping";
        try {
            let timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Backend did not respond within 5 seconds at ${url}`)), 5000)
            );
            let response = await Promise.race([fetch(url), timeout]);

            if (!response.ok) {
                return { ok: false, error: `HTTP ${response.status} from ${url}` };
            }

            let data = await response.json();
            return {
                ok: true,
                backend: data.backend || "unknown"
            };
        } catch (e) {
            let msg = e instanceof Error ? e.message : `Cannot reach backend at ${url}`;
            return { ok: false, error: msg };
        }
    },


    // -----------------------------------------------------------------------
    // Right-click handler
    // -----------------------------------------------------------------------

    /**
     * Handle the "Extract Section to Markdown…" menu item click.
     *
     * 1. Check backend health (GET /ping).
     * 2. Read selected item data.
     * 3. Open the extraction dialog.
     * 4. On Extract: run extraction, attach results, write traceability note.
     *
     * @param {Window} window - The Zotero window where the command was triggered
     */
    async onMenuItemCommand(window) {
        // 1. Backend health check before opening dialog
        let health = await this.checkBackendHealth();
        if (!health.ok) {
            this._showError(window,
                "Marker backend not reachable",
                health.error + "\n\n" +
                "Check the backend URL in Zotero \u2192 Settings \u2192 Estravon,\n" +
                "or start the backend with:\n\n" +
                "  cd src/backend && python -m estravon --port 7766"
            );
            return;
        }

        // 2. Read item data
        let itemData = await this.getSelectedItemWithPDF(window);
        if (!itemData) {
            this._showError(window,
                "No supported item selected",
                "Please select a Book, Book Section, Journal Article, Conference Paper, or Report that has a PDF attachment."
            );
            return;
        }

        Zotero.debug("[estravon] Opening dialog for: " + itemData.title +
                     " (sections: " + itemData.existingSections.length + ")");

        // 3. Read defaults from prefs
        let defaultChunkSize = Zotero.Prefs.get("extensions.estravon.defaultChunkSize", true) || 80;
        let defaultMode = Zotero.Prefs.get("extensions.estravon.defaultMode", true) || "balanced";

        // 4. Open extraction dialog (modal — blocks until closed)
        /** @type {DialogArgs} */
        let dialogArgs = {
            title:            itemData.title,
            backend:          health.backend || "unknown",
            itemType:         itemData.itemType,
            existingSections: itemData.existingSections,
            pdfAttachments:   itemData.pdfAttachments,
            defaultChunkSize,
            defaultMode,
            onExtract: async (/** @type {DialogFormData} */ formData) => {
                await this.runExtraction(
                    window, itemData.item, formData.selectedPdfPath, itemData.itemKey, formData
                );
            },
        };

        // Non-modal: importFromFile internally triggers Zotero's notifier which
        // needs the parent window's event loop to be running. A modal dialog blocks
        // that loop, causing importFromFile to hang until the dialog is closed.
        window.openDialog(
            "chrome://estravon/content/extract-dialog.xhtml",
            "estravon-extract",
            "chrome,dialog,centerscreen,resizable=no",
            dialogArgs
        );
    },


    // -----------------------------------------------------------------------
    // Extraction pipeline
    // -----------------------------------------------------------------------

    /**
     * Upload the PDF to /process and coordinate attachment + note update.
     *
     * Called from the dialog's onExtract callback (menu path) and from the public
     * extract() hook. Throws on error — the menu path's dialog re-enables its form via
     * the .catch() handler; extract() wraps this call in its own try/catch and converts
     * a thrown error into a resolved {status:"error"} result rather than propagating
     * the throw to its own caller.
     *
     * @param {Window|null}    window  - null when options.silent is true (no dialog to anchor)
     * @param {any}            item       - Zotero.Item (parent)
     * @param {string}         pdfPath    - Absolute path to the PDF
     * @param {string}         itemKey    - Zotero item key
     * @param {DialogFormData} formData
     * @param {{ silent?: boolean, attach?: boolean }} [options]
     *   silent (default false): when true, never calls _showError() — a background hook
     *     caller shouldn't have a modal dialog pop up in the user's Zotero window with
     *     no context for which add-on triggered it. The menu path relies on the dialog
     *     being shown, so it always passes silent:false (or omits options entirely).
     *   attach (default true): when false, skips attachResults()/updateTraceabilityNote()/
     *     tagging/registry update and instead fetches markdown text only, for a caller
     *     that wants to handle filing the result itself — used by the hook, never by
     *     the menu path.
     * @returns {Promise<{jobId: string, attachmentIDs: number[], markdown: {label:string,markdown:string}[]|null}>}
     */
    async runExtraction(window, item, pdfPath, itemKey, formData, options = {}) {
        const { silent = false, attach = true } = options;

        // FormData and Blob are not in Zotero's sandbox by default — import them
        Cu.importGlobalProperties(["Blob", "FormData"]);

        // 0. Session timing (shared with pollJobResult and _sendAck)
        const _session = {
            userTriggeredAt:  Date.now(),
            pdfReadAt:        null,
            trimDoneAt:       null,
            submitDoneAt:     null,
            firstPollAt:      null,
            resultReceivedAt: null,
            pollCount:        0,
            errorCount:       0,
        };

        // 1. Read PDF bytes
        let pdfBytes = await IOUtils.read(pdfPath);
        _session.pdfReadAt = Date.now();
        const originalSizeBytes = pdfBytes.byteLength;

        // 2a. Guard: reject files that would exceed the server's upload limit.
        //     Trimming only fires when a page range is set; without one, a file
        //     over 200 MB will be rejected by nginx as HTTP 413.
        if (originalSizeBytes > PDF_UPLOAD_LIMIT_BYTES && !formData.pageRange) {
            const sizeMB = (originalSizeBytes / 1024 / 1024).toFixed(0);
            throw new Error(
                `PDF is too large to upload in full (${sizeMB} MB). ` +
                `Set a page range to extract only the pages you need, ` +
                `or use a smaller document.`
            );
        }

        // 2b. Trim if: (a) a page range is specified AND (b) file exceeds threshold.
        //    If trim fails, fall back silently to the full file.
        let uploadBytes     = pdfBytes;
        let uploadPageRange = formData.pageRange;
        let pageOffset      = 0;

        if (formData.pageRange && pdfBytes.byteLength > PDF_TRIM_THRESHOLD_BYTES) {
            try {
                let parts = formData.pageRange.split("-");
                let start = parseInt(parts[0], 10);
                let end   = parseInt(parts[1], 10);

                Zotero.debug(
                    "[estravon] PDF " + (pdfBytes.byteLength / 1024 / 1024).toFixed(1) +
                    " MB > threshold — trimming to pages " + start + "-" + end
                );

                let trimResult = await this.trimPdfToPageRange(pdfBytes, start, end);
                uploadBytes     = trimResult.trimmedBytes;
                pageOffset      = start - 1;
                uploadPageRange = "1-" + trimResult.pageCount;

                pdfBytes = null;  // release original for GC before upload

                Zotero.debug(
                    "[estravon] Trimmed to " + (uploadBytes.byteLength / 1024 / 1024).toFixed(1) +
                    " MB, " + trimResult.pageCount + " pages, offset=" + pageOffset
                );
            } catch (e) {
                Zotero.debug("[estravon] PDF trim failed: " + e.message);
                uploadBytes     = pdfBytes;
                uploadPageRange = formData.pageRange;
                pageOffset      = 0;
            }
        }
        _session.trimDoneAt = Date.now();

        // Post-trim guard: abort if the file to upload is still over the server limit.
        // This catches both trim failures on large files and page ranges too large to reduce enough.
        if (uploadBytes.byteLength > PDF_UPLOAD_LIMIT_BYTES) {
            const sizeMB = (uploadBytes.byteLength / 1024 / 1024).toFixed(0);
            throw new Error(
                `PDF is too large to upload (${sizeMB} MB). ` +
                (formData.pageRange
                    ? "Trimming failed — try a smaller page range or use a smaller document."
                    : "Set a page range to extract only the pages you need.")
            );
        }

        // 3. Build multipart request
        let fd = new FormData();
        fd.append("pdf_file", new Blob([uploadBytes], { type: "application/pdf" }), itemKey + ".pdf");
        fd.append("section_name",    formData.sectionName);
        if (uploadPageRange) {
            fd.append("page_range", uploadPageRange);
        }
        fd.append("chunk_size",      String(formData.chunkSize));
        fd.append("mode",            formData.mode);
        fd.append("force_ocr",       String(formData.forceOcr || false));
        fd.append("source_item_key", itemKey);
        if (pageOffset > 0) {
            fd.append("page_offset", String(pageOffset));
        }

        // 4. Client context block — enriches server-side telemetry without extra round-trips
        fd.append("_client_pdf_size_bytes",     String(originalSizeBytes));
        fd.append("_client_pdf_trimmed",        String(pageOffset > 0));
        fd.append("_client_trimmed_size_bytes", String(uploadBytes.byteLength));
        fd.append("_client_time_setup_ms",      String(Date.now() - _session.userTriggeredAt));
        fd.append("_client_plugin_version",     PLUGIN_BUILD);

        // 3. POST /process
        //    Local backend:  waits synchronously, returns 200 + files.
        //    Hosted backend: returns 202 immediately; we poll GET /jobs/{id}.
        let response;
        try {
            response = await fetch(this.getBackendUrl() + "/process", {
                method: "POST",
                headers: this._backendHeaders(),
                body: fd,
            });
        } catch (e) {
            let msg = e instanceof Error ? e.message : "Network error contacting backend";
            if (!silent) this._showError(window, "Extraction failed", msg, e instanceof Error ? e : null);
            throw e;
        }

        if (!response.ok) {
            let errData = {};
            try { errData = await response.json(); } catch (_) {}
            let msg = (/** @type {any} */ (errData)).error || `HTTP ${response.status} from /process`;
            if (!silent) this._showError(window, "Extraction failed", msg);
            throw new Error(msg);
        }

        /** @type {ProcessResponse} */
        let processResponse;
        if (response.status === 202) {
            // Hosted backend: job queued — poll until done
            let queued = /** @type {QueuedResponse} */ (await response.json());
            _session.submitDoneAt = Date.now();
            Zotero.debug("[estravon] Job queued, rq_job_id=" + queued.job_id +
                         ", queue_position=" + queued.queue_position +
                         ", est_wait_s=" + queued.est_wait_s);
            // Show initial queue position in progress dialog before polling starts
            if (formData.onProgress) {
                let pos = queued.queue_position;
                let wait = queued.est_wait_s;
                let initMsg = (pos != null && pos > 0)
                    ? "Queued — " + pos + " job" + (pos === 1 ? "" : "s") +
                      " ahead" + (wait ? ", est. ~" + Math.round(wait) + "s" : "") + "…"
                    : "Queued — starting shortly…";
                formData.onProgress(initMsg);
            }
            try {
                processResponse = await this.pollJobResult(
                    queued.job_id,
                    formData.onProgress || null,
                    _session,
                );
            } catch (e) {
                if (!silent) {
                    this._showError(window, "Extraction failed",
                        e instanceof Error ? e.message : String(e),
                        e instanceof Error ? e : null);
                }
                throw e;
            }
        } else {
            // Local backend: synchronous 200 with result already in body
            processResponse = await response.json();
            _session.submitDoneAt = Date.now();
        }
        _session.resultReceivedAt = Date.now();

        Zotero.debug("[estravon] /process done, job_id=" + processResponse.job_id +
                     ", files=" + processResponse.files.length);

        /** @type {number[]} */
        let attachmentIDs = [];
        /** @type {{label:string,markdown:string}[]|null} */
        let markdown = null;

        if (attach) {
            // 4. Attach result files to Zotero item
            attachmentIDs = await this.attachResults(item, processResponse, { createNote: formData.createNote });

            // 5. Write / update traceability note
            await this.updateTraceabilityNote(item, processResponse, formData);

            // 6. Tag the parent item for global discovery
            item.addTag("estravon");
            await item.saveTx();

        } else {
            // attach:false (hook only, never the menu path) — resolve with markdown
            // text, no Zotero-side filing. Caller handles attaching/note-writing itself.
            markdown = await this._fetchMarkdownOnly(processResponse);
        }

        // 8. Send session ack (best-effort — never blocks the caller)
        await this._sendAck(processResponse.job_id, _session).catch(() => {});

        return { jobId: processResponse.job_id, attachmentIDs, markdown };
    },

    /**
     * Public extraction hook for other Zotero plugins — registered on the global
     * Zotero.Estravon object in init() above. Lets another add-on trigger extraction
     * through the installed Estravon plugin without knowing backend HTTP details or
     * re-implementing the attach/log steps.
     *
     * Three behaviours worth knowing about if you're calling this:
     *   - silent is a per-call opt-in (default true): a background caller never
     *        gets an unsolicited modal dialog in the user's Zotero window unless it
     *        explicitly asks for one via silent:false.
     *   - pdfAttachmentID, if omitted, resolves to the item's first PDF attachment
     *        in attachment order (see _resolveItemAndPdf()).
     *   - no dedicated completion event is fired; a caller that wants a
     *        fire-and-forget pattern should listen to Zotero's own native item-change
     *        notifications (triggered by Zotero.Attachments.importFromFile() inside
     *        attachResults()) rather than a custom Estravon event.
     *
     * Never rejects — always resolves, including on failure, so callers get a
     * predictable {status, ...} shape rather than needing a try/catch around every call.
     *
     * @param {HookExtractOptions} options
     * @returns {Promise<HookExtractResult>}
     */
    async extract(options) {
        try {
            // Destructured inside the try (with the `options || {}` fallback) rather
            // than at the top of the function: a caller invoking extract() with no
            // argument at all must still get a resolved {status:"error"} result, not a
            // rejected promise, per this method's never-rejects contract.
            const {
                itemID, pdfAttachmentID, pageRange, sectionName,
                mode, chunkSize, forceOcr = false,
                attach = true, silent = true,
            } = options || {};

            if (!itemID)     throw new Error("itemID is required");
            if (!sectionName) throw new Error("sectionName is required");
            if (!pageRange)   throw new Error("pageRange is required");

            let { item, pdfPath, itemKey } = await this._resolveItemAndPdf(itemID, pdfAttachmentID);

            let defaultChunkSize = Zotero.Prefs.get("extensions.estravon.defaultChunkSize", true) || 80;
            let defaultMode      = Zotero.Prefs.get("extensions.estravon.defaultMode", true) || "balanced";

            /** @type {DialogFormData} */
            let formData = {
                sectionName,
                selectedPdfPath: pdfPath,
                pageRange,
                chunkSize:  chunkSize || defaultChunkSize,
                mode:       /** @type {"fast"|"balanced"|"accurate"} */ (mode || defaultMode),
                forceOcr,
                createNote: false,
                onProgress: null,
            };

            // silent:true (default) → no window to anchor a dialog to, and
            // runExtraction() never calls _showError() when silent anyway.
            let window = silent ? null : (Zotero.getMainWindows()[0] || null);

            let result = await this.runExtraction(
                window, item, pdfPath, itemKey, formData, { silent, attach }
            );

            return {
                status:        "done",
                jobId:         result.jobId,
                markdown:      result.markdown || undefined,
                attachmentIDs: attach ? result.attachmentIDs : undefined,
            };
        } catch (e) {
            let message = e instanceof Error ? e.message : String(e);
            Zotero.debug("[estravon] Zotero.Estravon.extract failed: " + message);
            return { status: "error", error: message };
        }
    },

    /**
     * Download every output file from /files/... and attach to the Zotero item.
     *
     * @param {any}             item
     * @param {ProcessResponse} processResponse
     * @param {{ createNote?: boolean }} [options]
     * @returns {Promise<number[]>} Zotero item IDs of the created .md attachments
     *   (not the image attachments) — consumed by the public hook's `attachmentIDs`.
     */
    async attachResults(item, processResponse, options = {}) {
        let baseUrl = this.getBackendUrl();
        let tempDir = PathUtils.join(PathUtils.tempDir, "estravon-" + processResponse.job_id);
        Zotero.debug("[estravon] attachResults: tempDir=" + tempDir);
        await IOUtils.makeDirectory(tempDir, { ignoreExisting: true });

        /** @type {number[]} */
        let mdAttachmentIDs = [];

        try {
            for (let file of processResponse.files) {
                Zotero.debug("[estravon] attaching chunk: " + file.label);

                // --- Image files first (so we can capture storage keys for link rewriting) ---
                let contentTypeMap = /** @type {Record<string,string>} */ ({
                    jpg: "image/jpeg", jpeg: "image/jpeg",
                    png: "image/png",  webp: "image/webp",
                });
                /** @type {Record<string,string>} filename → 8-char Zotero storage key */
                let imageKeyMap = {};
                for (let imgUrl of file.image_urls) {
                    let filename = imgUrl.split("/").pop() || "image.jpg";
                    Zotero.debug("[estravon] attaching image: " + filename);
                    let ext = (filename.split(".").pop() ?? "jpg").toLowerCase();
                    let contentType = contentTypeMap[ext] || "application/octet-stream";
                    let buf = await (await fetch(baseUrl + imgUrl, { headers: this._backendHeaders() })).arrayBuffer();
                    Zotero.debug("[estravon] image fetched, bytes=" + buf.byteLength);
                    let imgPath = PathUtils.join(tempDir, filename);
                    await IOUtils.write(imgPath, new Uint8Array(buf));
                    let imgItem = await Zotero.Attachments.importFromFile({
                        file: imgPath,
                        parentItemID: item.id,
                        title: filename,
                        contentType,
                    });
                    if (imgItem && imgItem.key) {
                        imageKeyMap[filename] = imgItem.key;
                    }
                    Zotero.debug("[estravon] image imported, key=" + (imgItem && imgItem.key));
                    await IOUtils.remove(imgPath);
                }

                // --- Markdown file (rewrite image links to Zotero relative paths, then attach) ---
                let mdText = await (await fetch(baseUrl + file.md_url, { headers: this._backendHeaders() })).text();
                Zotero.debug("[estravon] md fetched, length=" + mdText.length);
                for (let [filename, key] of Object.entries(imageKeyMap)) {
                    mdText = mdText.replaceAll(`](${filename})`, `](../${key}/${filename})`);
                }
                let mdPath = PathUtils.join(tempDir, file.label + ".md");
                await IOUtils.writeUTF8(mdPath, mdText);
                Zotero.debug("[estravon] md written, calling importFromFile");
                let mdItem = await Zotero.Attachments.importFromFile({
                    file: mdPath,
                    parentItemID: item.id,
                    title: file.label + ".md",
                    contentType: "text/plain",
                });
                if (mdItem && mdItem.id) {
                    mdAttachmentIDs.push(mdItem.id);
                }
                Zotero.debug("[estravon] md imported");
                if (options.createNote) {
                    await this._createNoteFromMarkdown(item, file.label, mdText);
                }
                await IOUtils.remove(mdPath);
            }
        } finally {
            await IOUtils.remove(tempDir, { recursive: true }).catch(() => {});
        }

        return mdAttachmentIDs;
    },

    /**
     * Fetch each chunk's markdown text without attaching anything to Zotero — used by
     * extract({attach:false}). Unlike attachResults(), does not download images or
     * rewrite image links (there are no Zotero attachment keys to rewrite them to), so
     * image references in the returned markdown are left as the backend's relative
     * /files/... URLs for the caller to resolve against the backend base URL themselves.
     *
     * @param {ProcessResponse} processResponse
     * @returns {Promise<{label: string, markdown: string}[]>}
     */
    async _fetchMarkdownOnly(processResponse) {
        let baseUrl = this.getBackendUrl();
        /** @type {{label: string, markdown: string}[]} */
        let out = [];
        for (let file of processResponse.files) {
            let mdText = await (await fetch(baseUrl + file.md_url, { headers: this._backendHeaders() })).text();
            out.push({ label: file.label, markdown: mdText });
        }
        return out;
    },

    /**
     * Find or create the "[estravon] Extraction log" child note and
     * append a new row for this extraction.
     *
     * @param {any}             item
     * @param {ProcessResponse} processResponse
     * @param {DialogFormData}  formData
     * @returns {Promise<void>}
     */
    async updateTraceabilityNote(item, processResponse, formData) {
        const HEADER = "<h2>[estravon] Extraction log</h2>";
        const now = new Date();
        const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
        const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const shortJobId = processResponse.job_id.slice(0, 8);

        // Find existing log note among child notes
        let logNote = null;
        for (let id of item.getNotes()) {
            let note = Zotero.Items.get(id);
            if (note && note.getNote().includes(HEADER)) {
                logNote = note;
                break;
            }
        }

        // Create if not found
        if (!logNote) {
            logNote = new Zotero.Item("note");
            logNote.parentID = item.id;
            logNote.setNote(
                "<!-- schema_version: 1.2.0 -->\n" +
                HEADER + "\n\n" +
                "<table>" +
                "<thead><tr>" +
                "<th>Date</th><th>Job ID</th><th>Section</th>" +
                "<th>Pages</th><th>Mode</th><th>Force OCR</th><th>Chunks</th><th>Backend</th><th>PDF</th><th>Schema</th>" +
                "</tr></thead>" +
                "<tbody></tbody>" +
                "</table>"
            );
            await logNote.saveTx();
        }

        // Append new row before </tbody>
        let pdfFilename = formData.selectedPdfPath
            ? formData.selectedPdfPath.replace(/.*[/\\]/, "")
            : "";
        let newRow =
            `<tr>` +
            `<td>${date}</td>` +
            `<td>${shortJobId}</td>` +
            `<td>${formData.sectionName}</td>` +
            `<td>${formData.pageRange}</td>` +
            `<td>${formData.mode}</td>` +
            `<td>${formData.forceOcr ? "yes" : "no"}</td>` +
            `<td>${processResponse.files.length}</td>` +
            `<td>${processResponse.backend}</td>` +
            `<td>${pdfFilename}</td>` +
            `<td>1.2.0</td>` +
            `</tr>`;

        let html = logNote.getNote();
        logNote.setNote(html.replace("</tbody>", newRow + "</tbody>"));
        await logNote.saveTx();
    },


    // -----------------------------------------------------------------------
    // Markdown ↔ Zotero note conversion
    // -----------------------------------------------------------------------

    /**
     * Create a child Zotero note on `item` with the markdown content rendered as HTML.
     * Called once per chunk from attachResults() when options.createNote is true.
     *
     * Title format: <h2>[zm] label</h2> — distinct from the extraction log header
     * ("<h2>[estravon] Extraction log</h2>") so updateTraceabilityNote() never
     * confuses content notes with the log.
     *
     * @param {any}    item   - parent Zotero item
     * @param {string} label  - chunk label, e.g. "chapter_01_a"
     * @param {string} mdText - markdown text (with Zotero-internal image links already rewritten)
     * @returns {Promise<void>}
     */
    async _createNoteFromMarkdown(item, label, mdText) {
        Zotero.debug("[zm] _createNoteFromMarkdown: label=" + label);
        let noteHtml = markdownToNoteHtml(mdText);
        let noteItem = new Zotero.Item("note");
        noteItem.parentID = item.id;
        noteItem.setNote("<h2>[zm] " + label + "</h2>\n" + noteHtml);
        await noteItem.saveTx();
    },

    /**
     * Convert the selected .md attachment to a sibling Zotero note.
     * Triggered by "Convert to Zotero note" context menu item.
     *
     * @param {Window} window
     * @returns {Promise<void>}
     */
    async convertMdToNote(window) {
        Zotero.debug("[zm] convertMdToNote called");
        let items = window.ZoteroPane.getSelectedItems();
        let item = items[0];
        if (!item || !item.isAttachment()) return;

        let filePath = await item.getFilePath();
        if (!filePath) {
            this._showError(window, "File not found",
                "The markdown file is not available on disk. Is it synced?");
            return;
        }

        let mdText = await IOUtils.readUTF8(filePath);
        let noteHtml = markdownToNoteHtml(mdText);

        let parentItem = item.parentID ? Zotero.Items.get(item.parentID) : null;
        if (!parentItem) {
            this._showError(window, "No parent item",
                "This attachment has no parent item to attach the note to.");
            return;
        }

        let label = (item.getDisplayTitle() || "note").replace(/\.md$/, "");
        let noteItem = new Zotero.Item("note");
        noteItem.parentID = parentItem.id;
        noteItem.setNote("<h2>[zm] " + label + "</h2>\n" + noteHtml);
        await noteItem.saveTx();

        this._showInfo(window, "Conversion complete",
            "Created Zotero note “" + label + "” on “" +
            parentItem.getField("title") + "”.");
    },

    /**
     * Convert the selected child note to a .md file attachment on the same parent item.
     * Triggered by "Convert to Markdown file" context menu item.
     *
     * @param {Window} window
     * @returns {Promise<void>}
     */
    async convertNoteToMd(window) {
        Zotero.debug("[zm] convertNoteToMd called");
        let items = window.ZoteroPane.getSelectedItems();
        let item = items[0];
        if (!item || !item.isNote()) return;

        let parentItem = item.parentID ? Zotero.Items.get(item.parentID) : null;
        if (!parentItem) {
            this._showError(window, "No parent item",
                "This note has no parent item. Only child notes can be converted.");
            return;
        }

        let noteHtml = item.getNote();
        let mdText = noteHtmlToMarkdown(noteHtml);

        // Derive filename from first heading, falling back to "note"
        let titleMatch = noteHtml.match(/<h[12][^>]*>(.*?)<\/h[12]>/i);
        let baseTitle = titleMatch
            ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
            : "note";
        let filename = this._slugify(baseTitle) + ".md";

        let tempDir = PathUtils.join(PathUtils.tempDir, "estravon-convert");
        await IOUtils.makeDirectory(tempDir, { ignoreExisting: true });
        let tempPath = PathUtils.join(tempDir, filename);
        try {
            await IOUtils.writeUTF8(tempPath, mdText);
            await Zotero.Attachments.importFromFile({
                file: tempPath,
                parentItemID: parentItem.id,
                title: filename,
                contentType: "text/plain",
            });
        } finally {
            await IOUtils.remove(tempDir, { recursive: true }).catch(() => {});
        }

        this._showInfo(window, "Conversion complete",
            "Created “" + filename + "” on “" +
            parentItem.getField("title") + "”.");
    },

    // -----------------------------------------------------------------------
    // Workspace export
    // -----------------------------------------------------------------------

    /**
     * Handle the "Export to Workspace…" menu item click.
     *
     * Guards against a missing workspacesRoot pref, reads existing workspace
     * subdirectories, then opens the workspace picker dialog.  The actual
     * file copy is performed in exportToWorkspace() via the onConfirm callback.
     *
     * @param {Window} window
     */
    async onExportMenuItemCommand(window) {
        let rootPath = (Zotero.Prefs.get("extensions.estravon.workspacesRoot", true) || "").trim();
        if (!rootPath) {
            this._showError(window,
                "Workspaces folder not configured",
                "Set the workspaces root folder in\n" +
                "Zotero \u2192 Settings \u2192 Estravon \u2192 Workspace Export."
            );
            return;
        }

        let items = window.ZoteroPane.getSelectedItems();
        if (items.length !== 1) return;
        let item = items[0];

        let workspaces = await this._listWorkspaces(rootPath);
        let bookSlug   = this._slugify(item.getField("title") || "untitled");

        // Build sections list from .md attachments on this item
        /** @type {import("./estravon.js").SectionEntry[]} */
        let sections = [];
        for (let id of item.getAttachments()) {
            let att = Zotero.Items.get(id);
            if (!att) continue;
            let ct = att.attachmentContentType || "";
            let title = att.getDisplayTitle() || "";
            if (ct === "text/plain" && title.endsWith(".md")) {
                sections.push({ filename: title, label: title.slice(0, -3) });
            }
        }

        /** @type {WorkspaceDialogArgs} */
        let dialogArgs = {
            itemTitle:  item.getField("title") || "(untitled)",
            rootPath,
            workspaces,
            bookSlug,
            sections,
            onConfirm: async (workspacePath, selectedFilenames) => {
                try {
                    await this.exportToWorkspace(item, workspacePath, selectedFilenames);
                    this._showInfo(window, "Export complete",
                        "Exported to:\n" + workspacePath);
                } catch (e) {
                    this._showError(window, "Export failed", String(e), e instanceof Error ? e : null);
                }
            },
        };

        // Modal is fine here: exportToWorkspace only uses IOUtils (no Zotero
        // notifiers), so it does not need the parent window's event loop.
        window.openDialog(
            "chrome://estravon/content/workspace-dialog.xhtml",
            "estravon-workspace",
            "chrome,dialog,centerscreen,modal,resizable=no",
            dialogArgs
        );
    },

    /**
     * Return sorted names of immediate subdirectories under rootPath.
     * Returns [] if rootPath does not exist yet; the export will create it.
     *
     * @param {string} rootPath
     * @returns {Promise<string[]>}
     */
    async _listWorkspaces(rootPath) {
        try {
            let children = await IOUtils.getChildren(rootPath);
            let dirs = [];
            for (let childPath of children) {
                try {
                    let info = await IOUtils.stat(childPath);
                    if (info.type === "directory") {
                        dirs.push(PathUtils.filename(childPath));
                    }
                } catch (_) {
                    // Skip entries that can't be stat'd (broken symlinks, permission errors, etc.)
                }
            }
            return dirs.sort();
        } catch (_) {
            // rootPath doesn't exist yet — dialog will create it via makeDirectory
            return [];
        }
    },

    /**
     * Copy all .md and image attachments of *item* into a workspace subfolder.
     *
     * Folder layout created:
     *   workspacePath/
     *     <bookSlug>/
     *       chapter_01.md      ← Zotero-internal links rewritten to assets/
     *       assets/
     *         chapter_01_img_001.jpg
     *
     * Steps
     * -----
     * 1. Create bookDir and bookDir/assets/ (and any missing ancestors).
     * 2. Walk item.getAttachments() and split into .md files and images.
     * 3. Copy each image to assets/.
     * 4. For each .md: read, rewrite image links, write to bookDir.
     *
     * @param {any}      item              - Zotero.Item (parent)
     * @param {string}   workspacePath     - Absolute path to the selected workspace
     * @param {string[]} selectedFilenames - .md filenames to export (e.g. ["chapter_01.md"])
     */
    async exportToWorkspace(item, workspacePath, selectedFilenames) {
        let bookSlug  = this._slugify(item.getField("title") || "untitled");
        let bookDir   = PathUtils.join(workspacePath, bookSlug);
        let assetsDir = PathUtils.join(bookDir, "assets");

        // createAncestors:true creates rootPath/workspace/book in one call
        await IOUtils.makeDirectory(assetsDir, { createAncestors: true, ignoreExisting: true });

        // Partition attachments; filter .md by user selection
        let selectedSet = new Set(selectedFilenames);
        let mdAtts    = [];
        let imageAtts = [];
        for (let id of item.getAttachments()) {
            let att = Zotero.Items.get(id);
            if (!att) continue;
            let ct = att.attachmentContentType || "";
            let title = att.getDisplayTitle() || "";
            if (ct === "text/plain" && title.endsWith(".md")) {
                if (selectedSet.has(title)) mdAtts.push(att);
            } else if (ct.startsWith("image/")) {
                imageAtts.push(att);
            }
        }

        // Only copy images whose filename prefix matches a selected section
        // (chapter_01_img_001.jpg belongs to chapter_01.md → prefix "chapter_01")
        let selectedPrefixes = new Set(
            Array.from(selectedSet).map(f => f.slice(0, -3))  // strip ".md"
        );
        imageAtts = imageAtts.filter(att => {
            let fname = att.attachmentFilename || "";
            return Array.from(selectedPrefixes).some(pfx => fname.startsWith(pfx + "_img_"));
        });

        // 1. Copy images to assets/
        for (let att of imageAtts) {
            let src = await att.getFilePath();
            if (!src) continue;   // file not locally available (e.g. not yet synced)
            let dest = PathUtils.join(assetsDir, PathUtils.filename(src));
            await IOUtils.copy(src, dest);
        }

        // 2. Rewrite links and copy .md files to bookDir
        for (let att of mdAtts) {
            let src = await att.getFilePath();
            if (!src) continue;
            let text = await IOUtils.readUTF8(src);
            text = this._rewriteLinksForWorkspace(text);
            let dest = PathUtils.join(bookDir, PathUtils.filename(src));
            await IOUtils.writeUTF8(dest, text);
        }

        Zotero.debug("[estravon] exportToWorkspace: wrote " +
            mdAtts.length + " md, " + imageAtts.length + " images to " + bookDir);
    },

    /**
     * Rewrite Zotero-internal image links to workspace-relative paths.
     *
     * Zotero stores each attachment in its own 8-char hash directory, so
     * the .md files attached in Zotero contain links of the form:
     *   ../KDWDMTJG/chapter_01_img_001.jpg
     *
     * In the workspace the image lives at assets/chapter_01_img_001.jpg
     * (sibling to the .md file), so we rewrite to:
     *   assets/chapter_01_img_001.jpg
     *
     * The regex anchors on the exact Zotero key format ([A-Z0-9]{8}) so
     * it only replaces Zotero-internal links and leaves any other relative
     * links (e.g. existing assets/ links from a previous export) untouched.
     *
     * Forward slashes are used in the output — they work on Linux, macOS,
     * and Windows (accepted by all markdown renderers and modern Windows APIs).
     *
     * @param {string} text - Raw markdown content
     * @returns {string}
     */
    _rewriteLinksForWorkspace(text) {
        return text.replace(
            /\]\(\.\.\/[A-Z0-9]{8}\/([^)]+)\)/g,
            "](assets/$1)"
        );
    },

    /**
     * Convert an item title to a lowercase underscore-separated folder name.
     * Mirrors the backend's slugify() convention so book folder names are
     * predictable and consistent between backend and plugin.
     *
     * @param {string} title
     * @returns {string}
     */
    _slugify(title) {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .replace(/_+/g, "_")
            || "untitled";
    },

    // -----------------------------------------------------------------------
    // UI helpers
    // -----------------------------------------------------------------------

    /**
     * Build a structured debug report string for clipboard copy.
     *
     * @param {string} title
     * @param {string} message
     * @param {Error|null} error - original Error (for stack trace)
     * @returns {string}
     */
    _buildDebugReport(title, message, error) {
        let pluginVersion = (this._meta && this._meta.version) ? this._meta.version : "unknown";
        let zoteroVersion = (typeof Zotero !== "undefined" && Zotero.version) ? Zotero.version : "unknown";
        let backendUrl    = this.getBackendUrl();

        let lines = [
            "=== Estravon Debug Report ===",
            "Time:           " + new Date().toISOString(),
            "Build:          " + PLUGIN_BUILD,
            "Plugin version: " + pluginVersion,
            "Zotero version: " + zoteroVersion,
            "Backend URL:    " + backendUrl,
            "BackendUrl pref:" + Zotero.Prefs.get("extensions.estravon.backendUrl", true),
            "",
            "Error title:    " + title,
            "Message:        " + message,
        ];
        if (error instanceof Error) {
            if (error.stack) {
                lines.push("", "Stack trace:", error.stack);
            } else {
                lines.push("", "Error (no stack): " + String(error));
            }
        }
        return lines.join("\n");
    },

    /**
     * Show an error dialog. Offers a "Copy debug info" button that puts a
     * structured report (versions, backend URL, stack trace) on the clipboard.
     *
     * Only ever called with silent:false call sites in runExtraction() (window is
     * guaranteed real there); the |null case exists so the type matches the {Window|null}
     * window param threaded through runExtraction() for the silent:true / hook path,
     * which never reaches this function.
     *
     * @param {Window|null} window
     * @param {string}     title
     * @param {string}     message
     * @param {Error|null} [error=null] - original Error for stack trace
     */
    _showError(window, title, message, error = null) {
        let debugReport = this._buildDebugReport(title, message, error);

        // BUTTON_POS_0 = leftmost = "OK", BUTTON_POS_1 = "Copy debug info"
        let flags =
            Ci.nsIPromptService.BUTTON_POS_0 * Ci.nsIPromptService.BUTTON_TITLE_OK +
            Ci.nsIPromptService.BUTTON_POS_1 * Ci.nsIPromptService.BUTTON_TITLE_IS_STRING;
        let btn = Services.prompt.confirmEx(
            window, title, message, flags,
            "OK", "Copy debug info", null, null, { value: false }
        );
        if (btn === 1) {
            Cc["@mozilla.org/widget/clipboardhelper;1"]
                .getService(Ci.nsIClipboardHelper)
                .copyString(debugReport);
        }
    },

    /**
     * @param {Window} window
     * @param {string} title
     * @param {string} message
     */
    _showInfo(window, title, message) {
        Services.prompt.alert(window, title, message);
    },
};
