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
});
