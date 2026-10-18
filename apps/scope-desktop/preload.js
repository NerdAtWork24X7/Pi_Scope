// preload.js — minimal, context-isolated bridge between the Pi Scope WebUI
// renderer and the Electron main process.
//
// The BrowserWindow runs with contextIsolation: true and nodeIntegration: false,
// so the page cannot require() Electron or access Node. This file exposes only
// the narrow surface the UI needs. Today that is a single native directory
// picker used by the Chat view's "Add workspace" flow.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scopeNative", {
  /**
   * Open a native "select directory" dialog.
   * Resolves to the chosen absolute path (string) or null when cancelled.
   */
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),

  /**
   * Open a native "select files" dialog (files, images, documents — any type,
   * multi-select). Resolves to an array of absolute paths ([] when cancelled).
   * The Chat composer attaches these by path, so no upload is needed.
   */
  pickFiles: () => ipcRenderer.invoke("pick-files"),

  /**
   * The pre-launch port-conflict popup's bridge (see main.js / port-conflict.html).
   * `details()` describes the busy port and `ports()` lists every active Pi Scope
   * server; `checkPort(n)` validates a candidate; `killPort(n)` frees a port and
   * reports the outcome; and the `use*`/`quit` calls settle the launcher's choice
   * and close the popup.
   */
  portConflict: {
    details: () => ipcRenderer.invoke("port-conflict:details"),
    ports: () => ipcRenderer.invoke("port-conflict:ports"),
    state: () => ipcRenderer.invoke("port-conflict:state"),
    checkPort: (port) => ipcRenderer.invoke("port-conflict:check", port),
    killPort: (port) => ipcRenderer.invoke("port-conflict:kill-port", port),
    reuse: () => ipcRenderer.invoke("port-conflict:resolve", { action: "reuse" }),
    takePort: () => ipcRenderer.invoke("port-conflict:resolve", { action: "kill" }),
    usePort: (port) => ipcRenderer.invoke("port-conflict:resolve", { action: "port", port }),
    quit: () => ipcRenderer.invoke("port-conflict:resolve", { action: "quit" }),
  },
});
