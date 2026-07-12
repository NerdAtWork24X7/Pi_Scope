// main.js — Electron shell for the Pi Scope 1-click app.
// Boots the SCOPE server (or reuses a running one) and shows the WebUI in-app.
const { app, BrowserWindow, nativeImage } = require("electron");
app.setName("pi-scope-launcher");
const { ensureServer, stopServer } = require("./scope-control");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..", "..");
const PNG_ICON = path.join(ROOT, "apps", "scope-launcher", "icon.png");
const SVG_ICON = path.join(ROOT, "apps", "scope", "public", "logo.svg");
const APP_ICON = nativeImage.createFromPath(fs.existsSync(PNG_ICON) ? PNG_ICON : SVG_ICON);

// Headless/container-friendly flags.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
// Force WM_CLASS so the panel/dock matches this window to our .desktop (StartupWMClass).
app.commandLine.appendSwitch("class", "pi-scope-launcher");

let serverProc = null;

async function launch() {
  let result;
  try {
    result = await ensureServer();
  } catch (err) {
    console.error("[launcher] " + err.message);
    app.quit();
    return;
  }
  serverProc = result.proc;
  const { cfg } = result;
  const uiUrl = `http://${cfg.host}:${cfg.port}/?token=${encodeURIComponent(cfg.token)}`;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0e14",
    title: "Pi Scope",
    icon: APP_ICON,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  console.log("[launcher] SCOPE up — opening " + uiUrl);
  win.loadURL(uiUrl);
  win.webContents.on("did-finish-load", () => console.log("[launcher] UI loaded: " + uiUrl));
  console.log("[launcher] window created");

  win.on("closed", () => {
    if (result.spawned) stopServer(serverProc);
    serverProc = null;
  });
}

app.whenReady().then(launch);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (serverProc) stopServer(serverProc); });
