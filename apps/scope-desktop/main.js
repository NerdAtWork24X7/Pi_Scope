// main.js — Electron shell for the Pi Scope 1-click app.
// Boots the SCOPE server (or reuses a running one) and shows the WebUI in-app.
const { app, BrowserWindow, nativeImage, dialog, ipcMain } = require("electron");
app.setName("pi-scope-desktop");
const {
  config, prepareInstance, ensureServer, stopServer,
  probePort, listPortHolders, stopPort, findFreePort, discoverScopePorts, tokenDir, tokenForPort,
} = require("./scope-control");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = app.getAppPath();
const PNG_ICON = fs.existsSync(path.join(APP_DIR, "server-bundle", "icon.png"))
  ? path.join(APP_DIR, "server-bundle", "icon.png")
  : path.join(ROOT, "apps", "scope-desktop", "icon.png");
const SVG_ICON = path.join(APP_DIR, "server-bundle", "public", "logo.svg");
const APP_ICON = nativeImage.createFromPath(fs.existsSync(PNG_ICON) ? PNG_ICON : SVG_ICON);

// Headless/container-friendly flags.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
// Force WM_CLASS so the panel/dock matches this window to our .desktop (StartupWMClass).
app.commandLine.appendSwitch("class", "pi-scope-desktop");

let serverProc = null;
// True from the first port check until the main window exists. While booting the
// only window may briefly be none at all (the popup closing) — that must not be
// mistaken for "the user closed the app".
let booting = false;

// ── Port-conflict popup ──────────────────────────────────────────────────────
//
// Before booting, the launcher checks its port. If something is already there,
// the popup lets the user open the running instance, kill the holder and take
// the port, or start this instance on a different port — the last is how a
// second, independent app instance runs (see scope-control.prepareInstance).
let conflictWin = null;
let conflictDetails = null; // what the popup reads + validates against
let conflictToken = "";     // the busy server's token, for a graceful shutdown
let conflictResolve = null; // settles launch()'s choice

/** The popup page: packaged beside the bundle, or the source in a checkout. */
function conflictHtmlPath() {
  const bundled = path.join(APP_DIR, "server-bundle", "public", "port-conflict.html");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(ROOT, "apps", "scope-server", "public", "port-conflict.html");
}

/**
 * Show the busy-port popup and resolve with the user's choice:
 *   { action: "reuse" } | { action: "kill" } | { action: "port", port: n } | { action: "quit" }
 */
function showPortConflict(cfg, probe) {
  return new Promise((resolve) => {
    const holders = listPortHolders(cfg.port);
    findFreePort(cfg.displayHost, cfg.port + 1, 20).then((suggested) => {
      conflictDetails = {
        port: cfg.port,
        host: cfg.displayHost,
        state: probe.state, // "scope" | "other"
        version: probe.version || "",
        holders,
        suggested,
      };
      conflictToken = cfg.token || "";
      const settle = (choice) => {
        if (!conflictResolve) return;
        conflictResolve = null;
        conflictDetails = null;
        conflictToken = "";
        const win = conflictWin;
        conflictWin = null;
        if (win && !win.isDestroyed()) win.close();
        resolve(choice);
      };
      conflictResolve = settle;
      conflictWin = new BrowserWindow({
        width: 560,
        height: 704,
        minWidth: 520,
        minHeight: 460,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        backgroundColor: "#0a0a0a",
        title: "Pi Scope — ports",
        icon: APP_ICON,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: path.join(__dirname, "preload.js"),
        },
      });
      conflictWin.setMenuBarVisibility(false);
      conflictWin.once("ready-to-show", () => conflictWin && conflictWin.show());
      // Closing the popup (the window X) counts as "quit".
      conflictWin.on("closed", () => {
        conflictWin = null;
        if (conflictResolve) settle({ action: "quit" });
      });
      conflictWin.loadFile(conflictHtmlPath());
    });
  });
}

// The popup's IPC surface (see preload.js portConflict).
ipcMain.handle("port-conflict:details", () => conflictDetails);
ipcMain.handle("port-conflict:check", async (_event, value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "Enter a port between 1 and 65535." };
  }
  if (!conflictDetails) return { ok: false, reason: "No busy port to resolve." };
  if (port === conflictDetails.port) return { ok: false, reason: "That is the busy port — pick another." };
  const probe = await probePort(conflictDetails.host, port, { timeoutMs: 700 });
  if (probe.state === "free") return { ok: true, port };
  return {
    ok: false,
    reason: probe.state === "scope" ? `Port ${port} runs another Pi Scope server.` : `Port ${port} is already in use.`,
  };
});
// Which Pi Scope servers are listening right now (the popup's list).
ipcMain.handle("port-conflict:ports", async () => {
  if (!conflictDetails) return { ports: [] };
  const ports = await discoverScopePorts(conflictDetails.host, {
    port: conflictDetails.port,
    tokenDir: tokenDir(),
  });
  return { ports };
});
// The busy port's live state, so the popup can react once it is freed.
ipcMain.handle("port-conflict:state", async () => {
  if (!conflictDetails) return { state: "free" };
  const probe = await probePort(conflictDetails.host, conflictDetails.port, { timeoutMs: 700 });
  if (probe.state === "scope") {
    conflictDetails.state = "scope";
    conflictDetails.version = probe.version || "";
  }
  return { state: probe.state, version: probe.version || "" };
});
// Free one port (any of them). The busy port's token comes from our own config;
// another instance leaves its token in `scope_token.<port>`, which is enough to
// shut it down gracefully too (only a LAN-bound server asks for one).
ipcMain.handle("port-conflict:kill-port", async (_event, value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "Invalid port." };
  const host = conflictDetails ? conflictDetails.host : "127.0.0.1";
  const token = (conflictDetails && port === conflictDetails.port ? conflictToken : "") || tokenForPort(port);
  const res = await stopPort(port, { host, token });
  if (!res.ok) return { ok: false, reason: `Could not free port ${port} — it may need elevated permissions.` };
  return { ok: true, method: res.method };
});
ipcMain.handle("port-conflict:resolve", (_event, choice) => {
  if (conflictResolve) conflictResolve(choice && typeof choice === "object" ? choice : { action: "quit" });
  return true;
});

async function launch() {
  booting = true;

  // The base instance's files first, so config() reads this install's own token
  // (packaged keeps them in ~/.pi-scope) before we ask whether the port is busy.
  prepareInstance({});
  const baseCfg = config();
  const probe = await probePort(baseCfg.displayHost, baseCfg.port);

  let opts = {};
  if (probe.state !== "free") {
    const choice = await showPortConflict(baseCfg, probe);
    if (!choice || choice.action === "quit") { app.quit(); return; }
    if (choice.action === "reuse") {
      opts = { reuse: true };
    } else if (choice.action === "kill") {
      const freed = await stopPort(baseCfg.port, { host: baseCfg.displayHost, token: baseCfg.token });
      if (!freed.ok) console.error(`[launcher] could not free port ${baseCfg.port} (${freed.method})`);
      opts = { reuse: false };
    } else if (choice.action === "port") {
      console.log(`[launcher] starting a second instance on port ${choice.port}`);
      opts = { port: choice.port, reuse: false };
    }
  }

  let result;
  try {
    result = await ensureServer(opts);
  } catch (err) {
    console.error("[launcher] " + err.message);
    app.quit();
    return;
  }
  serverProc = result.proc;
  const { cfg } = result;
  const uiUrl = `http://${cfg.displayHost}:${cfg.port}/?token=${encodeURIComponent(cfg.token)}`;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0e14",
    title: "Pi Scope",
    icon: APP_ICON,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  booting = false;

  console.log("[launcher] SCOPE up — opening " + uiUrl);
  win.loadURL(uiUrl);
  win.webContents.on("did-finish-load", () => console.log("[launcher] UI loaded: " + uiUrl));
  console.log("[launcher] window created");

  win.on("closed", () => {
    if (result.spawned) stopServer(serverProc);
    serverProc = null;
  });
}

// Native directory picker for the Chat "Add workspace" flow. The renderer
// (contextIsolation: true) cannot call dialog directly, so the preload bridges
// it via ipcRenderer.invoke. Returns the chosen absolute path or null.
ipcMain.handle("pick-directory", async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: "Select workspace directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  } catch (err) {
    console.error("[launcher] pick-directory failed:", err.message);
    return null;
  }
});

// Native file picker for the Chat composer attachments. Files, images and
// documents of any type, multi-select; returns the chosen absolute paths (an
// empty array when cancelled). The composer sends these paths to pi, so the
// file's bytes are never copied — pi reads each file where it already lives.
ipcMain.handle("pick-files", async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "All Files", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePaths.length) return [];
    return result.filePaths;
  } catch (err) {
    console.error("[launcher] pick-files failed:", err.message);
    return [];
  }
});

app.whenReady().then(launch);
// While booting, closing the port popup is not "the user quit" — launch() is
// about to open the main window (or quits explicitly on its own).
app.on("window-all-closed", () => { if (!booting) app.quit(); });
app.on("before-quit", () => { if (serverProc) stopServer(serverProc); });
