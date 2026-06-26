// @ts-check
"use strict";

/**
 * preferences.js
 * ==============
 * Controller for the Estravon preferences pane (preferences.xhtml).
 *
 * Loaded via <script src="..."/> inside preferences.xhtml.
 * Provides manual connection-check buttons for the backend and tools server.
 */

// Assigned to window so oncommand attributes in the pane fragment can reach it.
// Plugin pane scripts run in a Cu.Sandbox(window, {sandboxPrototype: window});
// var declarations stay in the sandbox scope and are invisible to oncommand
// handlers, which execute in the preferences window context.
window.ZoteroMarkerPrefs = {

    // Map of element ID → preference key for all plain-text/number fields.
    _FIELDS: {
        "estravon-pref-backendUrl":    "extensions.estravon.backendUrl",
        "estravon-pref-apiKey":        "extensions.estravon.apiKey",
        "estravon-pref-chunkSize":     "extensions.estravon.defaultChunkSize",
        "estravon-pref-workspacesRoot":"extensions.estravon.workspacesRoot",
    },

    /**
     * Called once when the pane loads.
     *
     * Zotero 7 preference panes use <html:input preference="key"> but the
     * binding only works when a <preferences> container is present in the XUL.
     * Since this pane has none, we populate and save explicitly.
     *
     * Each field is populated from Zotero.Prefs on load, then a "change"
     * listener writes the new value back immediately when the field is edited.
     * This means there is no dependency on the dialog OK button lifecycle.
     */
    init() {
        Zotero.debug("[estravon] preferences.js init() running — build 2026-05-18T21:40Z");
        for (let [id, pref] of Object.entries(this._FIELDS)) {
            let el = document.getElementById(id);
            if (!el) continue;
            // Populate from Zotero.Prefs if a value was previously saved this way.
            let saved = Zotero.Prefs.get(pref, true);
            if (saved !== null && saved !== undefined && saved !== "") el.value = saved;
            el.addEventListener("change", () => {
                Zotero.Prefs.set(pref, el.value, true);
            });
        }
        // menulist for defaultMode
        let modeEl = document.getElementById("estravon-pref-mode");
        if (modeEl) {
            let saved = Zotero.Prefs.get("extensions.estravon.defaultMode", true);
            if (saved) modeEl.value = saved;
            modeEl.addEventListener("command", () => {
                Zotero.Prefs.set("extensions.estravon.defaultMode", modeEl.value, true);
            });
        }
        // Deferred sync: if the XUL preference-attribute binding populated fields
        // with values that were never written via Zotero.Prefs.set (e.g. backendUrl
        // before this fix), write them now so getBackendUrl() / getApiKey() etc. can
        // read them. Run after the current call stack so the binding has already run.
        setTimeout(() => {
            for (let [id, pref] of Object.entries(this._FIELDS)) {
                let el = document.getElementById(id);
                if (el && el.value !== "" && el.value !== null && el.value !== undefined) {
                    Zotero.Prefs.set(pref, el.value, true);
                }
            }
            if (modeEl && modeEl.value) {
                Zotero.Prefs.set("extensions.estravon.defaultMode", modeEl.value, true);
            }
        }, 0);
    },

    /**
     * Ping the backend URL and update the status label.
     * Reads the current value of the input field (not the saved pref) so the
     * user can check a URL before saving.
     */
    async checkBackend() {
        let input = document.getElementById("estravon-pref-backendUrl");
        let url   = (input ? input.value : "").trim() || "http://localhost:7766";
        let label = document.getElementById("zm-pref-backend-status");
        if (label) {
            label.setAttribute("value", "\u25CF Checking\u2026");
            label.style.color = "gray";
        }

        try {
            let timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 5000)
            );
            let resp = await Promise.race([fetch(url + "/ping"), timeout]);

            if (resp.ok) {
                let data = await resp.json().catch(() => ({}));
                let backend = data.backend || "unknown";
                if (label) {
                    label.setAttribute("value", "\u25CF Reachable \u2014 backend: " + backend);
                    label.style.color = "green";
                }
            } else {
                if (label) {
                    label.setAttribute("value", "\u2717 HTTP " + resp.status);
                    label.style.color = "red";
                }
            }
        } catch (e) {
            let msg = (e instanceof Error) ? e.message : String(e);
            if (label) {
                label.setAttribute("value", "\u2717 Unreachable: " + msg);
                label.style.color = "red";
            }
        }
    },

    /**
     * Open a native folder picker and write the chosen path into the
     * workspacesRoot preference field.
     *
     * nsIFilePicker is used directly because there is no higher-level
     * Zotero wrapper for folder selection that works inside a pref pane.
     * The callback form (fp.open(cb)) is required in Firefox 102+ — the
     * old synchronous showModal() was removed.
     */
    browseWorkspacesRoot() {
        let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
        // Zotero 7 / Firefox 102+: init() takes a BrowsingContext, not a window.
        // Passing window directly causes NS_ERROR_XPC_BAD_CONVERT_JS.
        fp.init(window.browsingContext, "Select workspaces root folder", Ci.nsIFilePicker.modeGetFolder);

        // Pre-populate with current value so the picker opens in the right place
        let current = (Zotero.Prefs.get("extensions.estravon.workspacesRoot", true) || "").trim();
        if (current) {
            try {
                fp.displayDirectory = Cc["@mozilla.org/file/local;1"]
                    .createInstance(Ci.nsIFile);
                fp.displayDirectory.initWithPath(current);
            } catch (_) {}
        }

        fp.open(rv => {
            if (rv === Ci.nsIFilePicker.returnOK) {
                let chosen = fp.file.path;
                let input = document.getElementById("estravon-pref-workspacesRoot");
                if (input) input.value = chosen;
                Zotero.Prefs.set("extensions.estravon.workspacesRoot", chosen, true);
            }
        });
    },

    /**
     * Call GET /account with the entered API key and display the credit balance.
     * Reads from the input field directly (same pattern as checkBackend) so
     * the user can verify before saving.
     */
    async checkBalance() {
        let keyInput = document.getElementById("estravon-pref-apiKey");
        let urlInput = document.getElementById("estravon-pref-backendUrl");
        let key = (keyInput ? keyInput.value : "").trim();
        let url = (urlInput ? urlInput.value : "").trim() || "http://localhost:7766";
        let label = document.getElementById("zm-pref-balance-status");

        if (!key) {
            if (label) {
                label.setAttribute("value", "✗ No API key entered");
                label.style.color = "red";
            }
            return;
        }

        if (label) {
            label.setAttribute("value", "● Checking…");
            label.style.color = "gray";
        }

        try {
            let timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 5000)
            );
            let resp = await Promise.race([
                fetch(url + "/account", { headers: { "X-API-Key": key } }),
                timeout,
            ]);

            if (resp.ok) {
                let data = await resp.json().catch(() => ({}));
                let balance = typeof data.credit_usd === "number" ? data.credit_usd : 0;
                let color = balance < 2 ? "orange" : "green";
                if (label) {
                    label.setAttribute("value", "● Balance: $" + balance.toFixed(4));
                    label.style.color = color;
                }
                // Also persist the key immediately so other pref pane interactions
                // don't lose it if the user forgets to click OK.
                Zotero.Prefs.set("extensions.estravon.apiKey", key, true);
            } else if (resp.status === 401) {
                if (label) {
                    label.setAttribute("value", "✗ Invalid or inactive key");
                    label.style.color = "red";
                }
            } else {
                if (label) {
                    label.setAttribute("value", "✗ HTTP " + resp.status);
                    label.style.color = "red";
                }
            }
        } catch (e) {
            let msg = (e instanceof Error) ? e.message : String(e);
            if (label) {
                label.setAttribute("value", "✗ " + msg);
                label.style.color = "red";
            }
        }
    },

};

window.ZoteroMarkerPrefs.init();
