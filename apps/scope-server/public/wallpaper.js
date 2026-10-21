/**
 * wallpaper.js — user-selected workspace background.
 *
 * The shell already paints every pane as translucent glass over one fixed
 * body background (see the glassmorphism notes in styles.css). This module
 * swaps that fixed layer for a picture the user picks, so the wallpaper shows
 * through the same panes the theme gradient does — no per-view changes.
 *
 * The whole preference lives in localStorage under `scope-wallpaper`:
 *
 *   { kind: "image" | "gradient", value: <data URL | http(s) URL | CSS image>,
 *     dim: 0..1, blur: 0..24, label: <string> }
 *
 * A picture is downscaled + re-encoded here before it is stored, because a
 * camera JPEG base64-encoded is far past the ~5 MB localStorage quota. If the
 * quota still trips, the image is re-encoded smaller (see writeWallpaper) and
 * the user is told, rather than silently losing the choice.
 *
 * index.html re-applies the stored value inline before first paint (so the
 * wallpaper does not flash in after boot); this file owns the picker UI and
 * every later change. IIFE-wrapped for scope isolation.
 */
(function () {
  const KEY = "scope-wallpaper";
  const DEFAULT_DIM = 0.14;
  const DEFAULT_BLUR = 0;
  const MAX_DIM = 0.8;
  const MAX_BLUR = 24;

  // Largest edge the stored copy keeps. Big enough for a 1440p window, small
  // enough that the JPEG lands in the low hundreds of KB.
  const STORE_MAX_EDGE = 2560;
  const STORE_QUALITY = 0.86;

  // Preset washes. They are plain CSS background images, so they cost nothing
  // to store and follow the theme through the same veil an image does.
  const PRESETS = [
    { id: "paper", label: "Paper", value: "linear-gradient(160deg, #fff7e0 0%, #fdfcf7 55%, #eef1e6 100%)" },
    { id: "bamboo", label: "Bamboo", value: "linear-gradient(145deg, #e7f0da 0%, #f7f4e3 58%, #fdfbf3 100%)" },
    { id: "mist", label: "Mist", value: "linear-gradient(150deg, #e8eef5 0%, #f7f7f5 55%, #eceee8 100%)" },
    { id: "dusk", label: "Dusk", value: "linear-gradient(160deg, #2c2c2a 0%, #3a3527 62%, #1b1b1a 100%)" },
  ];

  const $ = (s, root) => (root || document).querySelector(s);
  const body = document.body;

  // ─── Stored preference ────────────────────────────────────────────────────
  function loadWallpaper() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.value !== "string" || !raw.value) return null;
      return {
        kind: raw.kind === "gradient" ? "gradient" : "image",
        value: raw.value,
        dim: clampDim(raw.dim),
        blur: clampBlur(raw.blur),
        label: typeof raw.label === "string" ? raw.label : "",
      };
    } catch {
      return null;
    }
  }

  function clampDim(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_DIM;
    return Math.min(MAX_DIM, Math.max(0, n));
  }

  function clampBlur(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_BLUR;
    return Math.min(MAX_BLUR, Math.max(0, n));
  }

  /**
   * Persist a record. Returns false when the origin's storage quota is full —
   * the caller then re-encodes a picture smaller and tries again.
   */
  function writeWallpaper(next) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  }

  // ─── Painting ─────────────────────────────────────────────────────────────
  /** A CSS background-image value for a stored record. */
  function imageValue(rec) {
    if (!rec || !rec.value) return "none";
    if (rec.kind === "gradient") return rec.value;
    // Escape only what would break out of the url("…") token.
    return `url("${rec.value.replace(/["\\\n]/g, (c) => encodeURIComponent(c))}")`;
  }

  /**
   * Push a record (or null) onto the document. `--wallpaper-image`, `--dim` and
   * `--blur` are read by the wallpaper layer in styles.css; `has-wallpaper`
   * turns the translucent chrome on. The veil colour itself stays in CSS so it
   * follows the active theme without a re-render on theme toggle.
   */
  function applyWallpaper(rec) {
    const active = !!(rec && rec.value);
    body.classList.toggle("has-wallpaper", active);
    body.style.setProperty("--wallpaper-image", imageValue(rec));
    body.style.setProperty("--wallpaper-dim", String(active ? rec.dim : DEFAULT_DIM));
    body.style.setProperty("--wallpaper-blur", `${active ? rec.blur : DEFAULT_BLUR}px`);
    const btn = $("#btn-wallpaper");
    btn?.classList.toggle("active", active);
    btn?.setAttribute("aria-pressed", active ? "true" : "false");
  }

  let wallpaper = loadWallpaper();
  applyWallpaper(wallpaper);

  // ─── Image preparation ────────────────────────────────────────────────────
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That image could not be read."));
      img.src = src;
    });
  }

  /**
   * Downscale + re-encode a picked file to a storable JPEG data URL. Photos of
   * any size work; the longest edge is capped at `maxEdge`.
   */
  async function encodeFile(file, maxEdge, quality) {
    if (!file || !/^image\//.test(file.type || "")) {
      throw new Error("Choose an image file (PNG, JPEG, WebP, GIF…).");
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) throw new Error("That image could not be read.");
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("The browser could not decode that image.");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ─── Commits ──────────────────────────────────────────────────────────────
  let busy = false;

  function toast(msg, kind) {
    try { window.SCOPE?.toast?.(msg, kind || "ok"); } catch { /* toast is optional */ }
  }

  /**
   * Store + paint the next record. Pictures are retried at progressively lower
   * sizes when the origin is out of storage, and the panel reflects whatever
   * actually landed.
   */
  async function commit(patch, file) {
    const next = {
      kind: "gradient",
      value: "",
      dim: DEFAULT_DIM,
      blur: DEFAULT_BLUR,
      label: "",
      ...(wallpaper || {}),
      ...patch,
    };
    if (writeWallpaper(next)) {
      wallpaper = loadWallpaper() || next;
      applyWallpaper(wallpaper);
      syncPanel();
      return true;
    }
    // Out of quota. A picture can almost always be made to fit; a gradient
    // that fails means storage is unusable, which the user needs to hear.
    if (file) {
      for (const [edge, quality] of [[1600, 0.78], [1280, 0.68], [900, 0.58]]) {
        try {
          const dataUrl = await encodeFile(file, edge, quality);
          const smaller = { ...next, value: dataUrl };
          if (writeWallpaper(smaller)) {
            wallpaper = loadWallpaper() || smaller;
            applyWallpaper(wallpaper);
            syncPanel();
            toast("Background saved at a smaller size — storage is nearly full.", "warn");
            return true;
          }
        } catch {
          break;
        }
      }
    }
    toast("Could not save that background — this browser's storage is full.", "err");
    return false;
  }

  async function useFile(file) {
    if (busy || !file) return;
    if (file.size > 40 * 1024 * 1024) {
      toast("That image is too large (40 MB max).", "err");
      return;
    }
    busy = true;
    panel?.classList.add("busy");
    try {
      const dataUrl = await encodeFile(file, STORE_MAX_EDGE, STORE_QUALITY);
      await commit({ kind: "image", value: dataUrl, label: file.name || "image" }, file);
    } catch (e) {
      toast(e?.message || "That image could not be used.", "err");
    } finally {
      busy = false;
      panel?.classList.remove("busy");
    }
  }

  function useUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) {
      toast("Use an http(s) image URL.", "err");
      return;
    }
    // Persist the URL as the author wrote it; the browser fetches it like any
    // stylesheet image.
    void commit({ kind: "image", value, label: value });
  }

  /**
   * Dim/blur drags fire ~60 events per second and the stored record carries the
   * picture itself, so repaint on every event but only persist once the drag
   * settles.
   */
  let adjustTimer = 0;
  function adjust(patch) {
    if (!wallpaper) return;
    wallpaper = { ...wallpaper, ...patch };
    applyWallpaper(wallpaper);
    clearTimeout(adjustTimer);
    adjustTimer = setTimeout(() => {
      writeWallpaper(wallpaper);
      syncPanel();
    }, 160);
  }

  function usePreset(id) {
    if (id === "none") return removeWallpaper();
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    void commit({ kind: "gradient", value: preset.value, label: preset.label });
  }

  function removeWallpaper() {
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
    wallpaper = null;
    applyWallpaper(null);
    syncPanel();
  }

  // ─── Picker panel ─────────────────────────────────────────────────────────
  let panel = null;
  let open = false;

  const ICON_IMAGE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15.5 16 11l-6.5 6.5"/></svg>';

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "wallpaper-panel";
    panel.className = "wallpaper-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Background image");
    panel.hidden = true;
    panel.innerHTML =
      `<div class="wp-head">` +
        `<span class="wp-title">Background</span>` +
        `<button type="button" class="wp-close" aria-label="Close background picker">×</button>` +
      `</div>` +
      `<div class="wp-body">` +
        `<div class="wp-presets" role="group" aria-label="Presets">` +
          `<button type="button" class="wp-swatch wp-swatch-none" data-preset="none" title="No background">None</button>` +
          PRESETS.map((p) =>
            `<button type="button" class="wp-swatch" data-preset="${p.id}" title="${p.label}" ` +
            `aria-label="${p.label}" style="background-image:${p.value}"></button>`).join("") +
        `</div>` +
        `<button type="button" class="wp-drop" id="wp-pick">` +
          ICON_IMAGE +
          `<span class="wp-drop-text"><span class="wp-drop-main">Choose an image…</span>` +
          `<span class="wp-drop-sub">or drop one here</span></span>` +
        `</button>` +
        `<input type="file" id="wp-file" accept="image/*" hidden>` +
        `<div class="wp-url">` +
          `<input id="wp-url" type="url" placeholder="…or paste an image URL" spellcheck="false" ` +
          `autocomplete="off" aria-label="Image URL">` +
          `<button type="button" class="wp-apply" id="wp-url-apply">Use</button>` +
        `</div>` +
        `<div class="wp-sliders">` +
          `<label class="wp-slider" for="wp-dim"><span>Dim</span>` +
            `<input type="range" id="wp-dim" min="0" max="${Math.round(MAX_DIM * 100)}" step="2">` +
            `<output id="wp-dim-out" for="wp-dim"></output></label>` +
          `<label class="wp-slider" for="wp-blur"><span>Blur</span>` +
            `<input type="range" id="wp-blur" min="0" max="${MAX_BLUR}" step="1">` +
            `<output id="wp-blur-out" for="wp-blur"></output></label>` +
        `</div>` +
        `<div class="wp-foot">` +
          `<span class="wp-hint">Saved on this device</span>` +
          `<button type="button" class="wp-remove" id="wp-remove">Remove</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(panel);

    $(".wp-close", panel).addEventListener("click", () => close());
    $("#wp-remove", panel).addEventListener("click", removeWallpaper);
    $("#wp-pick", panel).addEventListener("click", () => $("#wp-file", panel).click());
    $("#wp-file", panel).addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // re-picking the same file must fire again
      if (file) void useFile(file);
    });
    panel.querySelectorAll("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => usePreset(b.dataset.preset)));
    const urlInput = $("#wp-url", panel);
    $("#wp-url-apply", panel).addEventListener("click", () => useUrl(urlInput.value));
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); useUrl(urlInput.value); }
    });
    $("#wp-dim", panel).addEventListener("input", (e) =>
      adjust({ dim: clampDim(Number(e.target.value) / 100) }));
    $("#wp-blur", panel).addEventListener("input", (e) =>
      adjust({ blur: clampBlur(Number(e.target.value)) }));
    // A drag that ends inside the debounce window must still persist.
    for (const id of ["#wp-dim", "#wp-blur"]) {
      $(id, panel).addEventListener("change", () => {
        clearTimeout(adjustTimer);
        if (wallpaper) writeWallpaper(wallpaper);
        syncPanel();
      });
    }
    // Dropping a picture anywhere on the panel picks it up.
    panel.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      panel.classList.add("dragging");
    });
    panel.addEventListener("dragleave", (e) => {
      if (e.target === panel) panel.classList.remove("dragging");
    });
    panel.addEventListener("drop", (e) => {
      panel.classList.remove("dragging");
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      void useFile(file);
    });
  }

  /** Mirror the stored record into the panel's controls. */
  function syncPanel() {
    if (!panel) return;
    const has = !!wallpaper?.value;
    panel.querySelectorAll("[data-preset]").forEach((b) => {
      const on = !has
        ? b.dataset.preset === "none"
        : wallpaper.kind === "gradient" && PRESETS.find((p) => p.id === b.dataset.preset)?.value === wallpaper.value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const dim = $("#wp-dim", panel);
    const blur = $("#wp-blur", panel);
    dim.value = String(Math.round((wallpaper ? wallpaper.dim : DEFAULT_DIM) * 100));
    blur.value = String(wallpaper ? wallpaper.blur : DEFAULT_BLUR);
    dim.disabled = !has;
    blur.disabled = !has;
    $("#wp-dim-out", panel).textContent = `${dim.value}%`;
    $("#wp-blur-out", panel).textContent = `${blur.value}px`;
    $("#wp-remove", panel).disabled = !has;
    $("#wp-url", panel).value = has && wallpaper.kind === "image" && /^https?:/i.test(wallpaper.value)
      ? wallpaper.value : "";
  }

  /** Park the panel under the header button, kept inside the viewport. */
  function placePanel() {
    const btn = $("#btn-wallpaper");
    if (!panel || !btn) return;
    const r = btn.getBoundingClientRect();
    const width = panel.offsetWidth || 300;
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, r.right - width));
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function openPanel() {
    if (!panel) buildPanel();
    syncPanel();
    panel.hidden = false;
    open = true;
    placePanel();
    $("#btn-wallpaper")?.setAttribute("aria-expanded", "true");
    $("#wp-pick", panel)?.focus();
  }

  function close() {
    if (!panel || !open) return;
    panel.hidden = true;
    open = false;
    $("#btn-wallpaper")?.setAttribute("aria-expanded", "false");
  }

  function togglePanel() {
    if (open) close();
    else openPanel();
  }

  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    if (panel?.contains(e.target) || $("#btn-wallpaper")?.contains(e.target)) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") { e.stopPropagation(); close(); }
  });
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);

  // ─── Public hooks ─────────────────────────────────────────────────────────
  // app.js owns the header button's click (it sits beside the theme toggle) and
  // calls this, mirroring how the rest of the shell's chrome is wired.
  window.__toggleWallpaper = togglePanel;
  window.__wallpaperState = () => (wallpaper ? { ...wallpaper } : null);
})();
