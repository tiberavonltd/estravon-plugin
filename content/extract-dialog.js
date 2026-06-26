// @ts-check
"use strict";

/**
 * extract-dialog.js
 * =================
 * Controller for the extraction dialog (extract-dialog.xhtml).
 *
 * Loaded via <script src="..."/> in the XUL dialog chrome context.
 * Communicates with estravon.js through window.arguments[0] (DialogArgs).
 *
 * Lifecycle:
 *   onLoad()     — called by xhtml onload; populates fields from dialogArgs
 *   onAccept()   — called by ondialogaccept; validates, disables form, fires callback
 *   onCancel()   — called by ondialogcancel; allows default close
 */

/**
 * Converts a title string to a filesystem-safe slug.
 * Example: "Optical Physics and Engineering" → "optical_physics_and_engineering"
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 80);
}

var ZoteroMarkerDialog = {

    /** @type {any} window.arguments[0] (DialogArgs shape) */
    _args: null,

    /** Slug computed from item title — used for paper no-split mode. @type {string} */
    _paperSlug: "",

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    onLoad() {
        this._args = window.arguments[0];

        // Give runExtraction a way to update the status label while polling.
        // Captured as a DOM reference (not via document) so it's safe across window contexts.
        let statusLabel = document.getElementById("zm-status-label");
        this._args._setProgress = /** @param {string} msg */ (msg) => {
            if (statusLabel) statusLabel.setAttribute("value", msg);
        };

        // Header labels
        document.getElementById("zm-item-title").setAttribute("value", this._args.title);
        document.getElementById("zm-backend-name").setAttribute("value", this._args.backend);

        // Populate PDF selector
        let pdfPopup = document.querySelector("#zm-pdf-select menupopup");
        for (let pdf of (this._args.pdfAttachments || [])) {
            let mi = document.createElementNS(
                "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "menuitem"
            );
            mi.setAttribute("label", pdf.title);
            mi.setAttribute("value", pdf.path);
            pdfPopup.appendChild(mi);
        }
        if (this._args.pdfAttachments && this._args.pdfAttachments.length > 0) {
            document.getElementById("zm-pdf-select").value = this._args.pdfAttachments[0].path;
        }

        // Prefs-based defaults
        document.getElementById("zm-chunk-size").value = String(this._args.defaultChunkSize);
        document.getElementById("zm-mode").value = this._args.defaultMode;

        // Classify item type
        let itemType = this._args.itemType || "";
        let isBook   = ["book", "bookSection"].includes(itemType);
        let isPaper  = ["journalArticle", "conferencePaper", "report", "preprint"].includes(itemType);
        let isPatent = itemType === "patent";

        // Show/hide type-specific rows
        document.getElementById("zm-toc-row").style.display       = isBook   ? "" : "none";
        document.getElementById("zm-split-row").style.display     = isPaper  ? "" : "none";
        document.getElementById("zm-force-ocr-row").style.display = isPatent ? "" : "none";

        if (isBook) {
            // Books: suggest chapter_NN in section name
            document.getElementById("zm-section-name").value =
                this._suggestSectionName(this._args.existingSections);

            // Wire TOC checkbox
            document.getElementById("zm-toc-checkbox").addEventListener("change", (e) => {
                let nameField = document.getElementById("zm-section-name");
                if (e.target.checked) {
                    nameField.value = "table_of_contents";
                    nameField.disabled = true;
                } else {
                    nameField.disabled = false;
                    nameField.value = this._suggestSectionName(this._args.existingSections);
                }
            });

        } else if (isPaper) {
            // Papers: slugified title, split checkbox
            this._paperSlug = slugify(this._args.title || "paper");
            document.getElementById("zm-section-name").value = this._paperSlug;
            document.getElementById("zm-paper-info").setAttribute(
                "value", "Full PDF \u2192 " + this._paperSlug + ".md"
            );
            this._setPaperSplitMode(false);

            document.getElementById("zm-split-checkbox")
                .addEventListener("change", (e) => this._setPaperSplitMode(e.target.checked));

        } else if (isPatent) {
            // Patents: slugified title (no split), accurate mode, force_ocr on by default
            window.Zotero?.debug("[zm] extract-dialog: isPatent=true, defaulting to accurate+force_ocr");
            this._paperSlug = slugify(this._args.title || "patent");
            document.getElementById("zm-section-name").value = this._paperSlug;
            document.getElementById("zm-mode").value = "accurate";
            /** @type {any} */ (document.getElementById("zm-force-ocr-checkbox")).checked = true;

        } else {
            // Fallback (unknown type): behave like book, no TOC row
            document.getElementById("zm-section-name").value =
                this._suggestSectionName(this._args.existingSections);
        }

        // Wire accept/cancel via addEventListener
        let dlg = document.querySelector("dialog");
        if (dlg) {
            if (dlg.getButton) {
                dlg.getButton("accept").label = "Extract";
            }
            dlg.addEventListener("dialogaccept", (e) => {
                e.preventDefault();
                this.onAccept();
            });
        }

        // Page range live validation on blur
        document.getElementById("zm-page-range")
            .addEventListener("blur", () => this._validatePageRange());
    },

    // -----------------------------------------------------------------------
    // Paper split mode
    // -----------------------------------------------------------------------

    /**
     * Toggle paper split mode: show/hide section-name and page-range rows.
     * @param {boolean} split
     */
    _setPaperSplitMode(split) {
        let sectionRow    = document.getElementById("zm-section-name-row");
        let pageRow       = document.getElementById("zm-page-range-row");
        let pageErrRow    = document.getElementById("zm-page-range-error-row");
        let infoRow       = document.getElementById("zm-paper-info-row");
        let totalPagesRow = document.getElementById("zm-total-pages-row");

        sectionRow.style.display    = split ? "" : "none";
        pageRow.style.display       = split ? "" : "none";
        pageErrRow.style.display    = split ? "" : "none";
        infoRow.style.display       = split ? "none" : "";
        if (totalPagesRow) totalPagesRow.style.display = split ? "none" : "";

        if (split) {
            document.getElementById("zm-section-name").value = this._paperSlug;
        }
    },

    // -----------------------------------------------------------------------
    // Section name suggestion helper
    // -----------------------------------------------------------------------

    /**
     * Suggest the next chapter_NN name based on existing sections.
     * Ignores non-chapter sections (e.g. table_of_contents).
     * @param {string[]} existingSections
     * @returns {string}
     */
    _suggestSectionName(existingSections) {
        let maxChapterNum = 0;
        for (let section of (existingSections || [])) {
            let m = /^chapter_(\d+)$/.exec(section);
            if (m) maxChapterNum = Math.max(maxChapterNum, parseInt(m[1], 10));
        }
        let nn = String(maxChapterNum + 1).padStart(2, "0");
        return "chapter_" + nn;
    },

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    /**
     * Validates the page range field.
     * Rule: /^\d+-\d+$/ and end > start.
     * @returns {boolean} true if valid
     */
    _validatePageRange() {
        let raw = document.getElementById("zm-page-range").value.trim();
        let errorLabel = document.getElementById("zm-page-range-error");
        let match = /^(\d+)-(\d+)$/.exec(raw);
        let msg = "";

        if (!match) {
            msg = "Format must be start-end (e.g. 14-200).";
        } else if (parseInt(match[2], 10) <= parseInt(match[1], 10)) {
            msg = "End page must be greater than start page.";
        }

        if (msg) {
            errorLabel.setAttribute("value", msg);
            errorLabel.style.visibility = "visible";
            return false;
        }

        errorLabel.style.visibility = "hidden";
        return true;
    },

    // -----------------------------------------------------------------------
    // Button handlers
    // -----------------------------------------------------------------------

    /**
     * Called when the user clicks Extract.
     * @returns {boolean}
     */
    onAccept() {
        let itemType = this._args.itemType || "";
        let isPaper  = ["journalArticle", "conferencePaper", "report", "preprint"].includes(itemType);
        let isSplit  = isPaper && document.getElementById("zm-split-checkbox").checked;

        // Determine page range
        let pageRange;
        if (isPaper && !isSplit) {
            // No-split paper: build "1-N" from the total-pages field
            let totalPagesEl = /** @type {HTMLInputElement} */ (document.getElementById("zm-total-pages"));
            let totalPages = parseInt(totalPagesEl ? totalPagesEl.value : "", 10);
            if (!totalPages || totalPages < 1) {
                alert("Please enter the total number of pages in the PDF.");
                return false;
            }
            pageRange = "1-" + totalPages;
        } else {
            if (!this._validatePageRange()) {
                let rawEl = /** @type {HTMLInputElement} */ (document.getElementById("zm-page-range"));
                if (!rawEl || !rawEl.value.trim()) {
                    alert("Please enter a page range (e.g. 14-200) before extracting.");
                }
                return false;
            }
            let pageRangeEl = /** @type {HTMLInputElement} */ (document.getElementById("zm-page-range"));
            pageRange = pageRangeEl ? pageRangeEl.value.trim() : "";
        }

        // Section name
        let sectionName;
        if (isPaper && !isSplit) {
            sectionName = this._paperSlug;
        } else {
            sectionName = document.getElementById("zm-section-name").value.trim();
            if (!sectionName) {
                alert("Section name must not be empty.");
                return false;
            }
        }

        let chunkSizeRaw = parseInt(document.getElementById("zm-chunk-size").value, 10);
        if (!chunkSizeRaw || chunkSizeRaw < 1) {
            alert("Pages per chunk must be a positive integer.");
            return false;
        }

        let createNoteCb = document.getElementById("zm-create-note-checkbox");
        let forceOcrCb   = document.getElementById("zm-force-ocr-checkbox");
        let formData = {
            sectionName,
            selectedPdfPath: document.getElementById("zm-pdf-select").value,
            pageRange,
            chunkSize: chunkSizeRaw,
            mode:       document.getElementById("zm-mode").value,
            onProgress: this._args._setProgress || null,
            createNote: createNoteCb ? /** @type {any} */ (createNoteCb).checked : false,
            forceOcr:   forceOcrCb   ? /** @type {any} */ (forceOcrCb).checked  : false,
        };

        this._disableForm();

        this._args.onExtract(formData)
            .then(() => {
                window.close();
            })
            .catch((err) => {
                this._enableForm();
                let msg = (err instanceof Error) ? err.message : String(err);
                alert("Extraction error: " + msg);
            });
    },

    /**
     * @returns {boolean}
     */
    onCancel() {
        return true;
    },

    // -----------------------------------------------------------------------
    // Form state helpers
    // -----------------------------------------------------------------------

    _disableForm() {
        for (let id of ["zm-section-name", "zm-page-range", "zm-total-pages", "zm-chunk-size"]) {
            document.getElementById(id).disabled = true;
        }
        document.getElementById("zm-pdf-select").setAttribute("disabled", "true");
        document.getElementById("zm-mode").setAttribute("disabled", "true");
        let tocCb = document.getElementById("zm-toc-checkbox");
        if (tocCb) tocCb.disabled = true;
        let splitCb = document.getElementById("zm-split-checkbox");
        if (splitCb) splitCb.disabled = true;
        let noteCb = document.getElementById("zm-create-note-checkbox");
        if (noteCb) /** @type {any} */ (noteCb).disabled = true;
        let forceOcrCb = document.getElementById("zm-force-ocr-checkbox");
        if (forceOcrCb) /** @type {any} */ (forceOcrCb).disabled = true;
        let dlg = document.querySelector("dialog");
        if (dlg && dlg.getButton) {
            dlg.getButton("accept").disabled = true;
            dlg.getButton("cancel").disabled = true;
        }
        document.getElementById("zm-status-row").style.visibility = "visible";
    },

    _enableForm() {
        for (let id of ["zm-section-name", "zm-page-range", "zm-total-pages", "zm-chunk-size"]) {
            document.getElementById(id).disabled = false;
        }
        document.getElementById("zm-pdf-select").removeAttribute("disabled");
        document.getElementById("zm-mode").removeAttribute("disabled");
        let tocCb = document.getElementById("zm-toc-checkbox");
        if (tocCb) tocCb.disabled = false;
        let splitCb = document.getElementById("zm-split-checkbox");
        if (splitCb) splitCb.disabled = false;
        let noteCb = document.getElementById("zm-create-note-checkbox");
        if (noteCb) /** @type {any} */ (noteCb).disabled = false;
        let forceOcrCb = document.getElementById("zm-force-ocr-checkbox");
        if (forceOcrCb) /** @type {any} */ (forceOcrCb).disabled = false;
        let dlg = document.querySelector("dialog");
        if (dlg && dlg.getButton) {
            dlg.getButton("accept").disabled = false;
            dlg.getButton("cancel").disabled = false;
        }
        document.getElementById("zm-status-row").style.visibility = "hidden";
    },
};
