/**
 * pixel.js — the Office's pixel-art tile renderer.
 *
 * The Office floor is a 16×16-tile pixel room: the carpet, the partition walls
 * and the walkway are painted onto a `<canvas>` that sits behind the DOM, while
 * the workstations and the agents stay DOM elements (see client.css) — the DOM
 * stays the layout authority and the accessibility/test surface, and this file
 * owns only the *world*: floor patterns, auto-tiled walls and the corridor.
 *
 * The art is the vendored pixel-agents sprite set (see assets/NOTICE.md):
 *   • `floors/floor_<n>.png` — grayscale 16×16 patterns, tinted at load time
 *     with the same Photoshop-style Colorize the upstream renderer uses
 *     (luminance → the theme's hue/saturation), so one gray tile becomes the
 *     theme's carpet without shipping a tile per theme.
 *   • `walls/wall_0.png` — a 64×128 sheet of 16 wall pieces of 16×32, indexed by
 *     the 4-bit cardinal-neighbour mask (N=1, E=2, S=4, W=8); a piece is drawn
 *     anchored to the BOTTOM of its tile because it is taller than a tile.
 *
 * Two rules shape the whole module:
 *
 * 1. **Nothing here is entrusted with layout.** `measure()` reads the rooms'
 *    rectangles out of the DOM and snaps them to the tile grid, so the CSS grid
 *    (which the room headers and tests both depend on) stays the single source
 *    of where things are. A room only has to be *roughly* tile-aligned; the
 *    snap absorbs the remainder, and because both the floor patterns and the
 *    wall ring are positional rather than sized, a few pixels of slack are
 *    invisible.
 * 2. **It never runs a frame loop.** The world is static, so it repaints on
 *    demand — a coalesced rAF after a measure, a container resize, or a theme
 *    flip — and is completely idle otherwise. The office already runs a 1 s
 *    data ticker; a second always-on animation frame would be pure waste.
 *
 * Assets are fetched from the plugin's own directory, which the server serves
 * behind the token (a `<script>`, an `<img>` or a CSS `url()` cannot send an
 * Authorization header), so the loader is handed a token-bearing base URL by
 * client.js and republishes every sprite as a CSS custom property instead —
 * `--px-spr-desk`, `--px-char-3`, … — which is how client.css dresses the DOM
 * without ever naming a URL it cannot authenticate. The pixel font is loaded
 * through the same base URL with the `FontFace` API for the same reason.
 */
(function () {
  const S = (window.SCOPE = window.SCOPE || {});
  if (S.OfficePixel) return;

  // ── Art geometry (art pixels; multiplied by SCALE for the screen) ────────
  /** Art pixels per tile — the pixel-agents grid. */
  const TILE = 16;
  /** Screen pixels per art pixel. 2 keeps the art chunky and readable at the
   *  desk sizes this floor uses (a desk is 48×32 art → 96×64 on screen). */
  const SCALE = 2;
  /** Wall pieces are one tile wide and TWO tiles tall, 4 to a sheet row. */
  const WALL_W = 16;
  const WALL_H = 32;
  const WALL_COLS = 4;
  const WALL_MASKS = 16;
  /** Character sheets: six palettes of 7 frames × 16×32 per row (down/up/right);
   *  client.css owns which frame is which, so only the count is needed here. */
  const CHAR_PALETTES = 6;
  /** Cardinal bits for the wall auto-tile mask (upstream `wallTiles.ts`). */
  const N = 1;
  const E = 2;
  const S_BIT = 4;
  const W = 8;

  /**
   * Every sprite this floor draws: `CSS var suffix → plugin-relative path`. The
   * atlas is vendored whole (assets/NOTICE.md), but a floor that fetches forty
   * PNGs to draw a dozen wastes the view's first paint — and the office is a view
   * the user flicks in and out of.
   */
  const SPRITES = {
    "desk": "furniture/DESK/DESK_FRONT.png",
    // One monitor, not the sheet's four frames: the "on" look is the DOM's code
    // lines over this sprite (client.css), so fetching the other three would be
    // three requests for art that is never drawn.
    "pc-off": "furniture/PC/PC_FRONT_OFF.png",
    "chair-front": "furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png",
    "chair-back": "furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_BACK.png",
    "chair-side": "furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_SIDE.png",
    "bench": "furniture/CUSHIONED_BENCH/CUSHIONED_BENCH.png",
    "plant2": "furniture/PLANT_2/PLANT_2.png",
    "cactus": "furniture/CACTUS/CACTUS.png",
    "pot": "furniture/POT/POT.png",
    "bin": "furniture/BIN/BIN.png",
    "coffee": "furniture/COFFEE/COFFEE.png",
    "bookshelf": "furniture/BOOKSHELF/BOOKSHELF.png",
    "table-small": "furniture/SMALL_TABLE/SMALL_TABLE_FRONT.png",
    "coffee-table": "furniture/COFFEE_TABLE/COFFEE_TABLE.png",
  };

  /**
   * The furniture the floor is dressed with where it is empty — the free tiles
   * inside a room's bottom corners, and the walkway between the rooms. Each is
   * `{ key, w, h }` in tiles, drawn anchored to the bottom-left of its footprint
   * (sprites are taller than a tile and stand on the one they occupy).
   */
  const PROPS = [
    { key: "plant2", w: 1, h: 2 },
    { key: "pot", w: 1, h: 1 },
    { key: "coffee-table", w: 2, h: 2 },
    { key: "bin", w: 1, h: 1 },
    { key: "cactus", w: 1, h: 2 },
  ];
  /** The walkway's own dressing, top to bottom as a fraction of the plan. */
  const WALK_PROPS = [
    { key: "coffee-table", at: 0.22 },
    { key: "plant2", at: 0.55 },
    { key: "bin", at: 0.84 },
  ];

  /** Floor patterns, in the sheet's order; index 0 is upstream's plain tile. */
  /**
   * Which floor sheet each part of the plan uses. The sheets are grayscale
   * patterns, so the *shape* is what distinguishes them: 1 is a single-tile
   * grid (a quiet carpet), 3 an 8-pixel checker (a rug), 5 a running bond (a
   * walkway, which is why it reads as tiling rather than carpet), 7 a dense
   * checker for the meeting room.
   */
  const FLOOR_OF = { floor: 1, corridor: 5, rug: 3, meeting: 7 };
  /** Wall / furniture tint presets are read from CSS; these are the fallbacks. */
  const DEFAULT_TINTS = {
    floor: [35, 30, 12, 0],
    rug: [30, 26, 4, 0],
    meeting: [205, 16, 6, 0],
    corridor: [35, 22, 2, 0],
  };
  /** How strongly the theme shift tints the wall + furniture art. */
  const SHIFT_DEFAULT = "none";

  // ── Colour maths (ported from upstream `office/colorize.ts`) ────────────

  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;
    if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const m = l - c / 2;
    return [r + m, g + m, b + m].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
  }

  /**
   * Photoshop-style Colorize: keep each pixel's perceived luminance, throw away
   * its hue, and re-tint with the given hue/saturation — after an optional
   * contrast stretch (`c`) and brightness shift (`b`), exactly as upstream
   * does. This is what turns the grayscale floor tiles into the theme's carpet.
   */
  function colorizePixels(px, [h, s, b, c]) {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      let l = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
      if (c !== 0) l = 0.5 + (l - 0.5) * ((100 + c) / 100);
      if (b !== 0) l += b / 200;
      const [r, g, bb] = hslToRgb(h, s / 100, Math.max(0, Math.min(1, l)));
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = bb;
    }
  }

  function ctxOf(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    return g;
  }

  /** A copy of `img` colorized for `tint`, cached so one tile is tinted once. */
  const tintCache = new Map();
  function tinted(img, tint, key) {
    const hit = tintCache.get(key);
    if (hit) return hit;
    const g = ctxOf(img.width, img.height);
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, img.width, img.height);
    colorizePixels(data.data, tint);
    g.putImageData(data, 0, 0);
    tintCache.set(key, g.canvas);
    return g.canvas;
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  let loading = null;
  let art = null;

  const varName = (k) => `--px-spr-${k}`;

  /**
   * One sprite's URL: the plugin-relative path resolved against the asset base,
   * with the caller's token attached — the plugin's own directory is served
   * behind the auth wall, and neither an `<img>` nor a CSS `url()` can carry an
   * Authorization header of its own. The base is a plain directory URL: a base
   * that already carried `?token=` would swallow the sprite path into the query.
   */
  function assetUrl(base, token, rel) {
    const url = new URL(rel, base || location.href);
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }

  function image(url) {
    return new Promise((resolve) => {
      const img = new Image();
      // A failed sprite must not take the whole floor down: the CSS falls back
      // to its own solid-colour drawing when the custom property is missing.
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  /**
   * Load the art once and publish it as CSS custom properties on `host`.
   *
   * Idempotent: concurrent or repeated calls share the first run, because the
   * plugin's `onShow` may fire again (a view switch, a reconnect) long before
   * the art is on screen the first time.
   */
  function load(host, base, token) {
    // A call with no base (the bundle was loaded from an unexpected place) must
    // not latch: the next call with a real base still has to load the art.
    if (!base) return Promise.resolve(null);
    if (loading) return loading;
    const url = (rel) => assetUrl(base, token, rel);
    loading = (async () => {
      // The pixel font cannot be declared in CSS — `@font-face` src is a URL the
      // browser fetches with no way to attach the token — so it is registered
      // here, off the same authenticated base. It is deliberately NOT awaited: it
      // is a megabyte, the canvas beneath the labels does not need it, and the
      // browser re-lays the text out on its own the moment it arrives. Until
      // then the family falls through to the mono stack in client.css.
      try {
        const face = new FontFace("FS Pixel Sans", `url("${url("fonts/FSPixelSansUnicode-Regular.ttf")}")`);
        void face.load().then((f) => document.fonts.add(f)).catch(() => {});
      } catch { /* fall back to the mono stack */ }

      // Only the sheets FLOOR_OF names: the other patterns are on disk but never
      // painted, and each one is a request the view does not need.
      const floors = {};
      await Promise.all(Object.values(FLOOR_OF).map(async (i) => {
        const img = await image(url(`floors/floor_${i}.png`));
        if (img) floors[i] = img;
      }));
      const wallImg = await image(url("walls/wall_0.png"));
      const sprites = {};
      await Promise.all(Object.entries(SPRITES).map(async ([k, rel]) => {
        const img = await image(url(rel));
        if (img) sprites[k] = img;
      }));
      art = { base, token, floors, wallImg, sprites };

      for (const k of Object.keys(sprites)) {
        if (host) host.style.setProperty(varName(k), `url("${url(SPRITES[k])}")`);
      }
      for (let i = 0; i < CHAR_PALETTES; i++) {
        if (host) host.style.setProperty(`--px-char-${i}`, `url("${url(`characters/char_${i}.png`)}")`);
      }
      if (host) {
        host.style.setProperty("--px-tile", `${TILE * SCALE}px`);
        host.dataset.pixelArt = "ready";
      }
      return art;
    })();
    return loading;
  }

  /** `img` with the theme's shift filter applied, cached per (sprite, shift). */
  function shifted(img, shift, key) {
    if (!img || !shift) return img;
    const hit = tintCache.get(key);
    if (hit) return hit;
    const g = ctxOf(img.width, img.height);
    g.filter = shift;
    g.drawImage(img, 0, 0);
    tintCache.set(key, g.canvas);
    return g.canvas;
  }

  // ── Model ───────────────────────────────────────────────────────────────

  const snap = (v) => Math.round(v / (TILE * SCALE)) * TILE * SCALE;

  function num(v, d) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : d;
  }

  /** Read the four colourize parameters the stylesheet publishes for a role. */
  function tintOf(cs, role) {
    const raw = cs.getPropertyValue(`--px-tint-${role}`).trim();
    const parts = raw ? raw.split(/[\s,]+/).map((v) => Number.parseFloat(v)) : [];
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v))) return parts;
    return DEFAULT_TINTS[role] || DEFAULT_TINTS.floor;
  }

  /**
   * The theme's hue/brightness shift for the *wall and furniture* art, which
   * upstream ships pre-coloured (a beige wall, a wood desk). A missing
   * `--px-art-shift` means "draw the art exactly as it is", which is the light
   * theme; the dark theme shifts it a few degrees cooler and dimmer so the
   * illustration sits with the dark chrome instead of glowing out of it.
   */
  function shiftOf(cs) {
    const raw = cs.getPropertyValue("--px-art-shift").trim();
    return raw === "none" ? "" : raw;
  }

  /**
   * Snapshot the DOM: where each room is (snapped to the tile grid), what kind
   * of room it is and which room it is (`data-room`, so a doorway can name the
   * room it belongs to), plus the plan's own box.
   */
  function measure(planEl, roomStyle) {
    const plan = planEl.getBoundingClientRect();
    const rooms = [];
    const pods = [];
    for (const el of planEl.querySelectorAll(".office-pod")) {
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      pods.push({ x: b.left - plan.left, y: b.top - plan.top, w: b.width, h: b.height });
    }
    for (const el of planEl.children) {
      if (!el.classList || !el.classList.contains("office-room")) continue;
      const r = el.getBoundingClientRect();
      // Skip a room that is not laid out yet (a hidden view has no boxes).
      if (r.width < TILE * SCALE || r.height < TILE * SCALE) continue;
      rooms.push({
        id: (el.dataset && el.dataset.room) || "",
        x: snap(r.left - plan.left),
        y: snap(r.top - plan.top),
        w: Math.max(TILE * SCALE, snap(r.width)),
        h: Math.max(TILE * SCALE, snap(r.height)),
        style: roomStyle ? roomStyle(el) : "team",
      });
    }
    return { w: Math.max(1, planEl.clientWidth), h: Math.max(1, planEl.clientHeight), rooms, pods };
  }

  /**
   * Mark every wall tile — and punch each team room's doorway.
   *
   * Only a TEAM's room is walled. The orchestrator's office, the meeting room
   * and the ad-hoc desks sit on an open floor: the walls are what enclose a team,
   * so the room an agent belongs to is read from the plan instead of from the
   * roster. The top band of a room is deliberately left open — that is where the
   * room's own header plate sits (see client.css), and leaving it un-walled is
   * what makes the side pieces come out as end caps instead of running off the
   * top.
   *
   * Each team room gets a DOOR: a two-tile opening in the wall that faces the
   * center pathway (a room left of the pathway opens right, one on the right
   * opens left). It is where the orchestrator walks in to hand a task over, so
   * the doorways are returned for the walk to be aimed at the real opening.
   */
  function wallGrid(model) {
    const t = TILE * SCALE;
    const grid = new Set();
    const doors = [];
    for (const r of model.rooms) {
      if (r.style !== "team") continue;
      // The ring is snapped OUTWARD (floor on the near edges, ceil on the far
      // ones) so its inner edge is always at or outside the room's own box. The
      // DOM insets its content by exactly one tile (client.css), so the desks and
      // the room's plate can never land on top of a wall — the CSS grid decides
      // where things are, and this only has to agree with it, not the other way
      // round.
      const c0 = Math.floor(r.x / t);
      const c1 = Math.ceil((r.x + r.w) / t) - 1;
      const r0 = Math.floor(r.y / t);
      const r1 = Math.ceil((r.y + r.h) / t) - 1;
      // The doorway sits on the room's own middle, and never touches the south
      // wall: a door in a corner would read as a hole in the room, not a way in.
      const leftSide = (r.x + r.w / 2) < model.w / 2;
      const doorCol = leftSide ? c1 : c0;
      const doorRow = Math.min(r0 + ((r1 - r0) >> 1) - 1, Math.max(r0, r1 - 2));
      const doorRows = [doorRow, doorRow + 1];
      doors.push({
        id: r.id || "",
        side: leftSide ? "right" : "left",
        col: doorCol,
        rows: doorRows,
        // The waypoint a walk-in aims at: the middle of the opening, in plan px.
        x: (leftSide ? doorCol + 1 : doorCol) * t,
        y: (doorRow + 1) * t,
      });
      for (let y = r0; y <= r1; y++) {
        if (doorRows.includes(y)) continue;
        grid.add(`${c0},${y}`);
        grid.add(`${c1},${y}`);
      }
      for (let x = c0; x <= c1; x++) grid.add(`${x},${r1}`);
    }
    return { grid, doors };
  }

  function wallMask(grid, x, y) {
    let mask = 0;
    if (grid.has(`${x},${y - 1}`)) mask |= N;
    if (grid.has(`${x + 1},${y}`)) mask |= E;
    if (grid.has(`${x},${y + 1}`)) mask |= S_BIT;
    if (grid.has(`${x - 1},${y}`)) mask |= W;
    return mask;
  }

  // ── Painting ────────────────────────────────────────────────────────────

  /**
   * Fill a rectangle with a repeating tile. Every fill is anchored to the
   * canvas origin rather than to the rectangle, so a rug laid inside a room
   * stays in step with the corridor floor running beside it instead of
   * restarting the pattern at its own corner.
   */
  function tile(g, img, x, y, w, h) {
    if (!img || w <= 0 || h <= 0) return;
    const pattern = g.createPattern(img, "repeat");
    if (!pattern) return;
    g.fillStyle = pattern;
    g.fillRect(x, y, w, h);
  }

  /**
   * Dress the floor where it is empty.
   *
   * A room hugs its team (see client.css), so a small team leaves floor to
   * spare. Rather than stretching the desks apart to fill it, the free tiles are
   * furnished — a plant, a coffee table, a bin — which is what a real floor
   * looks like, and what stops a two-desk room reading as mostly carpet. The
   * walkway gets its own coffee point. Nothing is placed on a tile a desk
   * occupies, so this can never collide with the DOM above it.
   */
  function dressFloor(g, model, palette, t) {
    const props = palette.props;
    if (!props || !props.length) return;
    const occupied = new Set();
    // A doorway is floor, not a wall — never stand a plant in one.
    for (const d of (model.doors || [])) {
      for (const row of d.rows) occupied.add(`${d.col},${row}`);
    }
    for (const p of model.pods) {
      const c0 = Math.floor(p.x / t);
      const c1 = Math.ceil((p.x + p.w) / t) - 1;
      const r0 = Math.floor(p.y / t);
      const r1 = Math.ceil((p.y + p.h) / t) - 1;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occupied.add(`${c},${r}`);
    }
    const draw = (prop, col, row, maxCol) => {
      if (!prop || !prop.img) return;
      // Never let a wide prop cross the wall ring: a two-tile table needs two
      // free columns, so it is skipped rather than drawn through the wall.
      if (col + prop.w - 1 > maxCol) return;
      g.drawImage(prop.img, col * t, (row - prop.h + 1) * t, prop.w * t, prop.h * t);
    };

    // A room's own corners: the leftmost and the rightmost free tile of its
    // lowest rows, one tile in from its walls.
    model.rooms.forEach((room, i) => {
      const c0 = Math.floor(room.x / t) + 1;
      const c1 = Math.ceil((room.x + room.w) / t) - 2;
      const rTop = Math.floor(room.y / t) + 1;
      const rBot = Math.ceil((room.y + room.h) / t) - 2;
      const spots = [];
      for (let r = rBot; r >= rTop && spots.length < 2; r--) {
        // The leftmost and then the rightmost free tile of this row, so a room
        // is dressed at its corners rather than in one heap.
        for (const c of [c0, c1]) {
          if (spots.length >= 2) break;
          if (spots.some((sp) => sp.col === c)) continue;
          if (occupied.has(`${c},${r}`)) continue;
          spots.push({ col: c, row: r });
        }
      }
      spots.forEach((sp, k) => draw(props[(i + k) % props.length], sp.col, sp.row, c1));
    });

    // The walkway: a coffee point and greenery down the corridor.
    const byX = [...model.rooms].sort((a, b) => a.x - b.x);
    if (byX.length < 2) return;
    const gapStart = byX[0].x + byX[0].w;
    const right = byX.filter((r) => r.x > gapStart);
    if (!right.length) return;
    const gapEnd = Math.min(...right.map((r) => r.x));
    if (gapEnd - gapStart < t) return;
    const col = Math.round((gapStart + gapEnd) / 2 / t) - 1;
    for (const w of WALK_PROPS) {
      const prop = props.find((p) => p.key === w.key) || props[0];
      const row = Math.round((model.h / t) * w.at);
      if (occupied.has(`${col},${row}`)) continue;
      draw(prop, col, row, col + 1);
    }
  }

  function paint(canvas, model, palette) {
    const g = canvas.getContext("2d");
    const scale = SCALE;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const t = TILE * scale;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, model.w, model.h);

    const { floor, rug, meeting, corridor } = palette;

    // 1. The carpet: one pattern under everything, including the corridors.
    tile(g, floor, 0, 0, model.w, model.h);

    // 2. Each room gets its own rug, laid one tile inside its box — the same
    //    tile maths the wall ring below uses, so the carpet ends exactly where
    //    the walls begin (and the ring is only computed once per paint).
    for (const r of model.rooms) {
      const img = r.style === "meeting" ? meeting : rug;
      const x0 = Math.floor(r.x / t) * t + t;
      const y0 = Math.floor(r.y / t) * t + t;
      const x1 = Math.ceil((r.x + r.w) / t) * t - t;
      const y1 = Math.ceil((r.y + r.h) / t) * t - t;
      tile(g, img, x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    }

    // 3. The walkway between the two room columns: the gap the rooms leave in
    //    the middle of the floor gets a paler pattern, which is what makes the
    //    plan read as a corridor with rooms off either side.
    if (model.rooms.length > 1) {
      const cols = [...model.rooms].sort((a, b) => a.x - b.x);
      const gapStart = cols[0].x + cols[0].w;
      const right = cols.filter((r) => r.x > gapStart);
      if (right.length) {
        const gapEnd = Math.min(...right.map((r) => r.x));
        if (gapEnd - gapStart >= t) tile(g, corridor, gapStart, 0, gapEnd - gapStart, model.h);
      }
    }

    // 4. The walls: one auto-tiled piece per wall tile. A piece is two tiles
    //    tall, and upstream draws it one tile above its cell (`offsetY =
    //    TILE - sprite.length`), so the ring's face reads as a wall seen from
    //    above rather than a strip sitting on the floor. Each team room's
    //    doorway is a gap in that ring (see wallGrid).
    const { grid, doors } = wallGrid(model);
    // The walk-in route (client.js) reads the doorways off the model, so they
    // ride along with the geometry the DOM just measured.
    model.doors = doors;
    const wall = palette.wall;
    if (wall) {
      for (const key of grid) {
        const [cx, cy] = key.split(",").map(Number);
        const mask = wallMask(grid, cx, cy);
        const sx = (mask % WALL_COLS) * WALL_W;
        const sy = Math.floor(mask / WALL_COLS) * WALL_H;
        g.drawImage(
          wall,
          sx, sy, WALL_W, WALL_H,
          cx * t, cy * t - TILE * scale, WALL_W * scale, WALL_H * scale,
        );
      }
    }

    // 5. The doorway thresholds: the pieces are two tiles tall, so the wall art
    //    of the cell below a skipped one still reaches up into the opening. The
    //    doorway is painted back in after the walls, leaving a pale strip of
    //    corridor floor where the door is.
    if (corridor) {
      for (const d of doors) tile(g, corridor, d.col * t, d.rows[0] * t, t, t * d.rows.length);
    }

    // 6. Furniture on the floor that is left over.
    dressFloor(g, model, palette, t);
  }

  // ── Mount ───────────────────────────────────────────────────────────────

  /**
   * Attach a canvas to `planEl` and keep it in step with the DOM.
   *
   * `opts.roomStyle(el)` classifies a room element ("meeting", "orchestrator",
   * …) so this file never has to learn the office's own vocabulary;
   * `opts.onMeasure(model)` is a hook for the caller to react to the geometry.
   */
  function mount(host, planEl, opts) {
    const options = opts || {};
    const canvas = document.createElement("canvas");
    canvas.className = "office-tiles";
    canvas.setAttribute("aria-hidden", "true");
    let model = { w: 0, h: 0, rooms: [] };
    let frame = 0;
    let dead = false;

    /** Read the current theme's palette out of the stylesheet. */
    function palette() {
      const cs = getComputedStyle(host);
      const tints = {
        floor: tintOf(cs, "floor"),
        rug: tintOf(cs, "rug"),
        meeting: tintOf(cs, "meeting"),
        corridor: tintOf(cs, "corridor"),
      };
      const key = [tints.floor, tints.rug, tints.meeting, tints.corridor].flat().join("_");
      const out = {};
      for (const role of Object.keys(tints)) {
        const img = art && art.floors[FLOOR_OF[role]];
        // A missing sheet must not blank the floor: fall back to the plain tile
        // and finally to whatever sheet did load.
        const src = img || (art && (art.floors[FLOOR_OF.floor] || Object.values(art.floors)[0])) || null;
        out[role] = src ? tinted(src, tints[role], `${role}:${key}`) : null;
      }
      const shift = shiftOf(cs);
      const wall = art ? shifted(art.wallImg, shift, `wall:${shift}`) : null;
      out.wall = wall;
      // Props ride the same theme shift as the wall, so a dark floor's plants
      // are not a lit light-theme green.
      out.props = PROPS.map((p) => {
        const img = art && art.sprites[p.key];
        if (!img) return { ...p, img: null };
        return { ...p, img: shifted(img, shift, `prop:${p.key}:${shift}`) };
      });
      return out;
    }

    /** Coalesce every repaint request into one frame. */
    function schedule() {
      if (dead || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (dead || !canvas.isConnected) return;
        model = measure(planEl, options.roomStyle);
        // A hidden view has no layout: leave the last floor on the canvas rather
        // than clearing it to nothing (the ResizeObserver fires again on show).
        if (model.w < TILE * SCALE * 2 || model.h < TILE * SCALE * 2) return;
        const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
        const w = Math.max(1, Math.round(model.w * dpr));
        const h = Math.max(1, Math.round(model.h * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        paint(canvas, model, palette());
        if (options.onMeasure) options.onMeasure(model);
      });
    }

    planEl.insertBefore(canvas, planEl.firstChild);

    // A view switch and a roster change both rebuild the plan's innerHTML, which
    // throws the canvas away with the rooms — so re-attach it whenever it has
    // been detached, then repaint.
    const attach = new MutationObserver(() => {
      if (!canvas.isConnected) planEl.insertBefore(canvas, planEl.firstChild);
      schedule();
    });
    attach.observe(planEl, { childList: true });

    const resize = new ResizeObserver(schedule);
    resize.observe(planEl);

    // The theme lives on <body> as an attribute, so a flip is a mutation here —
    // and it must re-tint, not just repaint.
    const theme = new MutationObserver(() => schedule());
    for (const el of [document.documentElement, document.body]) {
      theme.observe(el, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class"] });
    }

    if (document.fonts && document.fonts.ready) void document.fonts.ready.then(schedule);

    schedule();

    return {
      /** Re-measure and repaint (call after the plan's markup is rebuilt). */
      refresh: schedule,
      /** The last measured model — the room rectangles, in plan pixels. */
      model: () => model,
      destroy() {
        dead = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        attach.disconnect();
        resize.disconnect();
        theme.disconnect();
        canvas.remove();
      },
    };
  }

  /** A stable sprite palette per agent, so a desk never changes character. */
  function charIndex(key) {
    let h = 2166136261;
    const s = String(key || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % CHAR_PALETTES;
  }

  S.OfficePixel = { load, mount, charIndex, TILE, SCALE, colors: { colorizePixels, hslToRgb } };
})();
