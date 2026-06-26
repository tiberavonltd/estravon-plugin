// @ts-check
"use strict";

/**
 * workspace-dialog.js
 * ===================
 * Controller for workspace-dialog.xhtml.
 *
 * Loaded via <script src="..."/> inside workspace-dialog.xhtml.
 * Receives its data through window.arguments[0] (WorkspaceDialogArgs),
 * following the same pattern as extract-dialog.js.
 *
 * Dialog flow
 * -----------
 * 1. onLoad() populates the workspace menulist from args.workspaces.
 * 2. A sentinel item "── New workspace ──" is appended at the bottom.
 * 3. When the sentinel is selected, zmw-new-row appears for the user to
 *    type a name.  The export-path preview updates live on every keystroke.
 * 4. The section listbox shows one checkbox row per .md attachment.
 *    All sections are pre-checked; the user unchecks what they don't want.
 * 5. On Accept, onAccept() calls args.onConfirm(workspacePath, selectedFilenames)
 *    and returns true.  If validation fails it returns false and prevents close.
 *
 * Note: the dialogaccept event fires synchronously; onConfirm is an async
 * function called without await so the dialog closes immediately and the
 * export runs in the background, reporting success/failure via the parent
 * window's _showInfo/_showError helpers.
 */

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const SENTINEL = "__new__";

// Assigned to window so XUL oncommand/oninput attributes can reach it.
window.ZoteroMarkerWorkspaceDialog = {

    /** @type {import("../estravon.js").WorkspaceDialogArgs|null} */
    _args: null,

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    onLoad() {
        this._args = window.arguments[0];

        document.getElementById("zmw-item-title").setAttribute("value", this._args.itemTitle);
        document.getElementById("zmw-root-path").setAttribute("value", this._args.rootPath);

        this._populateList(this._args.workspaces);
        this._populateSections(this._args.sections);
    },

    // ------------------------------------------------------------------
    // List population
    // ------------------------------------------------------------------

    /**
     * Fill the workspace menulist.
     * If no existing workspaces are found the sentinel is the only item,
     * which pre-selects "New workspace" and shows the name input immediately.
     *
     * @param {string[]} workspaces - Sorted directory names under rootPath
     */
    _populateList(workspaces) {
        let list   = document.getElementById("zmw-workspace-list");
        let popup  = list.querySelector("menupopup");

        // Clear any stale items (dialog could in theory be reused)
        while (popup.firstChild) popup.removeChild(popup.firstChild);

        for (let ws of workspaces) {
            let item = document.createElementNS(XUL_NS, "menuitem");
            item.setAttribute("label", ws);
            item.setAttribute("value", ws);
            popup.appendChild(item);
        }

        // Sentinel entry — always last
        let sentinel = document.createElementNS(XUL_NS, "menuitem");
        sentinel.setAttribute("label", "\u2500\u2500 New workspace \u2500\u2500");
        sentinel.setAttribute("value", SENTINEL);
        popup.appendChild(sentinel);

        // Pre-select first real workspace, or the sentinel if none exist
        list.selectedIndex = 0;
        this.onSelect();   // sync show/hide state with initial selection
    },

    /**
     * Fill the section vbox with one XUL checkbox per .md attachment.
     * All rows are pre-checked.
     *
     * @param {import("../estravon.js").SectionEntry[]} sections
     */
    _populateSections(sections) {
        let container = document.getElementById("zmw-section-list");
        while (container.firstChild) container.removeChild(container.firstChild);

        for (let sec of sections) {
            let cb = document.createElementNS(XUL_NS, "checkbox");
            cb.setAttribute("label", sec.label);
            cb.setAttribute("checked", "true");
            cb.setAttribute("data-filename", sec.filename);
            cb.style.margin = "2px 0";
            container.appendChild(cb);
        }
    },

    // ------------------------------------------------------------------
    // Event handlers
    // ------------------------------------------------------------------

    onSelect() {
        let isNew = this._selectedValue() === SENTINEL;
        document.getElementById("zmw-new-row").style.display = isNew ? "" : "none";
        // Resize the dialog window to fit the newly shown/hidden row
        window.sizeToContent();
        if (isNew) {
            document.getElementById("zmw-new-name").focus();
        }
        this._updatePreview();
    },

    onNewNameInput() {
        this._updatePreview();
    },

    selectAll() {
        for (let cb of document.getElementById("zmw-section-list").querySelectorAll("checkbox")) {
            cb.checked = true;
        }
    },

    selectNone() {
        for (let cb of document.getElementById("zmw-section-list").querySelectorAll("checkbox")) {
            cb.checked = false;
        }
    },

    // ------------------------------------------------------------------
    // Accept / validation
    // ------------------------------------------------------------------

    /**
     * Called by the dialogaccept event listener.  Returns false to cancel
     * closing when the form is incomplete.
     *
     * @returns {boolean}
     */
    onAccept() {
        let name = this._resolvedWorkspaceName();
        if (!name) return false;

        let selectedFilenames = this._selectedFilenames();
        if (selectedFilenames.length === 0) return false;

        let workspacePath = PathUtils.join(this._args.rootPath, name);
        // Fire-and-forget: export runs after dialog closes
        this._args.onConfirm(workspacePath, selectedFilenames);
        return true;
    },

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** @returns {string|null} */
    _selectedValue() {
        let list = document.getElementById("zmw-workspace-list");
        return list.selectedItem ? list.selectedItem.getAttribute("value") : null;
    },

    /**
     * Returns the workspace name to use: either the selected existing
     * workspace name, or the typed new name.  Returns "" if incomplete.
     *
     * @returns {string}
     */
    _resolvedWorkspaceName() {
        let val = this._selectedValue();
        if (!val) return "";
        if (val !== SENTINEL) return val;
        return (document.getElementById("zmw-new-name").value || "").trim();
    },

    /**
     * Returns filenames of checked section rows (e.g. ["chapter_01.md"]).
     *
     * @returns {string[]}
     */
    _selectedFilenames() {
        let result = [];
        for (let cb of document.getElementById("zmw-section-list").querySelectorAll("checkbox")) {
            if (cb.checked) result.push(cb.getAttribute("data-filename"));
        }
        return result;
    },

    _updatePreview() {
        let name     = this._resolvedWorkspaceName();
        let bookSlug = this._args.bookSlug;
        let preview  = name
            ? PathUtils.join(this._args.rootPath, name, bookSlug)
            : "";
        document.getElementById("zmw-export-path")
            .setAttribute("value", preview || "(select or name a workspace)");
    },
};

window.addEventListener("dialogaccept", e => {
    if (!ZoteroMarkerWorkspaceDialog.onAccept()) {
        e.preventDefault();
    }
});
