/**
 * bootstrap.js
 * ============
 * Zotero plugin lifecycle hooks for estravon.
 *
 * Zotero calls these four functions at the appropriate lifecycle events.
 * The plugin object (ZoteroMarker) is loaded from estravon.js on
 * startup and cleaned up on shutdown.
 *
 * Environment note
 * ----------------
 * bootstrap.js runs in a sandbox without global variables like `window`
 * or `Zotero`. The `{ id, version, rootURI }` destructured from the
 * first argument provides the plugin's identity and file root.
 *
 * `rootURI` is a string URL ending in `/` — append relative paths to
 * load bundled files (e.g. `rootURI + "estravon.js"`).
 */

// Module-level reference to the plugin object, set in startup()
var ZoteroMarker;

// Module-level chrome handle, must be destructed in shutdown()
var chromeHandle;

/**
 * Called when the plugin is enabled or Zotero starts with the plugin
 * already enabled.
 *
 * @param {object} params - { id, version, rootURI }
 * @param {number} reason - APP_STARTUP | ADDON_ENABLE | ADDON_INSTALL | ADDON_UPGRADE
 */
function startup({ id, version, rootURI }, reason) {
    // 1. Register chrome resources
    var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
        .getService(Ci.amIAddonManagerStartup);
    var manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
        ["content", "estravon", "content/"],
        ["locale",  "estravon", "en-US", "locale/en-US/"]
    ]);

    // 2. Load main plugin script into this sandbox's scope
    Services.scriptloader.loadSubScript(rootURI + "estravon.js");

    // 3. Initialise
    ZoteroMarker.init({ id, version, rootURI });

    // 4. Add UI to any Zotero windows already open
    ZoteroMarker.addToAllWindows();
}

/**
 * Called when the plugin is disabled or Zotero shuts down.
 *
 * CRITICAL: must remove all injected DOM elements to avoid orphan nodes
 * after disable/uninstall, and must destruct the chromeHandle to avoid
 * leaking chrome registrations across disable/enable cycles.
 *
 * @param {object} params - { id, version, rootURI }
 * @param {number} reason - APP_SHUTDOWN | ADDON_DISABLE | ADDON_UNINSTALL | ADDON_DOWNGRADE
 */
function shutdown({ id, version, rootURI }, reason) {
    ZoteroMarker.removeFromAllWindows();
    if (chromeHandle) {
        chromeHandle.destruct();
        chromeHandle = null;
    }
    ZoteroMarker = undefined;
}

/**
 * Called by Zotero 7/8 each time the main Zotero window opens.
 * This is the correct hook for injecting per-window UI elements.
 *
 * @param {{ window: Window }} params
 */
function onMainWindowLoad({ window }) {
    if (ZoteroMarker && window.ZoteroPane) {
        ZoteroMarker.addToWindow(window);
    }
}

/**
 * Called by Zotero 7/8 each time the main Zotero window closes.
 *
 * @param {{ window: Window }} params
 */
function onMainWindowUnload({ window }) {
    if (ZoteroMarker) {
        ZoteroMarker.removeFromWindow(window);
    }
}

/**
 * Called once when the plugin is first installed.
 * No action needed — preferences are set via prefs.js defaults.
 */
function install({ id, version, rootURI }, reason) {}

/**
 * Called once when the plugin is uninstalled.
 * No action needed — Zotero handles preference cleanup.
 */
function uninstall({ id, version, rootURI }, reason) {}
