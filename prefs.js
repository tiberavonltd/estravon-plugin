/**
 * prefs.js
 * ========
 * Default preference values for estravon.
 *
 * Preference key convention: all keys are prefixed with
 * "extensions.estravon." to avoid conflicts with other plugins.
 *
 * Zotero reads this file once at plugin install time. The values here
 * are defaults — user overrides persist across restarts and upgrades.
 */

// --- Backend connection ---

/**
 * API key for the hosted estravon backend.
 * Required when connecting to api.estravon.com.
 * Leave empty for local (self-hosted) deployments — no auth needed.
 */
pref("extensions.estravon.apiKey", "");


/**
 * Base URL of the estravon Python backend.
 * Default: "http://localhost:7766" (same-machine deployment).
 *
 * The plugin appends API paths to this URL:
 *   - backendUrl + "/ping"     → health check
 *   - backendUrl + "/process"  → extraction request
 *   - backendUrl + "/files/…"  → result file download
 */
pref("extensions.estravon.backendUrl", "http://localhost:7766");

// --- Extraction defaults ---

/**
 * Default number of PDF pages per extraction chunk.
 * 80 pages is safe for most PDFs; reduce for scanned books with heavy
 * image content.
 */
pref("extensions.estravon.defaultChunkSize", 80);

/**
 * Default extraction quality mode: "fast", "balanced", or "accurate".
 * "balanced" is the best trade-off for most items.
 */
pref("extensions.estravon.defaultMode", "balanced");

// --- First-launch onboarding ---

/**
 * Set to true after the plugin has opened the "Get started" page on first install.
 * Prevents repeated opens on every Zotero restart.
 */
pref("extensions.estravon.firstLaunchDone", false);

// --- Workspace export ---

/**
 * Absolute path to the folder that contains all workspaces.
 * Subdirectories of this path are the individual workspaces shown in the
 * "Export to Workspace…" dialog.  Empty string means not yet configured;
 * the export command will prompt the user to set this first.
 */
pref("extensions.estravon.workspacesRoot", "");
