/**
 * files.js — Files view: list git-modified files for a session's cwd and show a
 * Beyond-Compare-style side-by-side diff (git HEAD vs working tree) with per-line
 * copy arrows (← / →) and dual editable panes. Self-contained IIFE.
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.SCOPE.api;
  const selectedCwd = window.SCOPE.currentCwd;

  const cwdLabel = $("#files-cwd-label");
  const filesList = $("#files-list");
  const filesStatus = $("#files-status");
  const diffOld = $("#diff-old-lines");
  const diffNew = $("#diff-new-lines");
  const diffOldCol = $(".diff-col-old");
  const diffNewCol = $(".diff-col-new");
  const diffFilename = $("#diff-filename");
  const diffStats = $("#diff-stats");
  const btnSave = $("#btn-diff-save");
  const btnCancel = $("#btn-diff-cancel");
  const btnRefresh = $("#btn-files-refresh");
  const btnFilesToggle = $("#btn-files-toggle");
  const btnIgnored = $("#btn-files-ignored");
  const btnMode = $("#btn-diff-mode");
  const btnWrap = $("#btn-diff-wrap");
  const diffGrid = $(".diff-grid");
  const diffResizer = $("#diff-resizer");
  const filesResizer = $("#files-resizer");

  const LINE_CAP = 6000; // combined line count for highlighted diff; above this render plain
  const MAX_CELLS = 9_000_000; // m*n bound for the LCS table
  const STATUS_LABEL = { modified: "M", added: "A", deleted: "D", untracked: "?", renamed: "R", ignored: "I" };

  let current = { cwd: "", file: "", oldBuf: [], newBuf: [], binary: false, dirty: false, baseOldBuf: [], baseNewBuf: [] };
  let activeSide = "new";
  let fullView = true;
  let showIgnored = false; // file list starts by hiding everything .gitignore matches

  function refreshCwd() {
    window.SCOPE.cwdLabel(cwdLabel);
  }

  function clearDiff() {
    current = { cwd: current.cwd, file: "", oldBuf: [], newBuf: [], binary: false, dirty: false, baseOldBuf: [], baseNewBuf: [] };
    diffFilename.textContent = "no file selected";
    diffStats.textContent = "";
    diffOld.innerHTML = "";
    diffNew.innerHTML = "";
    exitEditMode();
  }

  async function loadModified() {
    const cwd = selectedCwd();
    current.cwd = cwd;
    filesStatus.textContent = "";
    filesList.innerHTML = '<div class="empty-state">scanning…</div>';
    if (!cwd) {
      filesList.innerHTML = '<div class="empty-state">no working directory set — choose one in the Terminal pane</div>';
      clearDiff();
      return;
    }
    // `.gitignore`-matched files are hidden unless the user opts in with the
    // gitignore button (the server only includes them when `ignored=1`).
    const ignored = showIgnored ? 1 : 0;
    try {
      const { res, data } = await api("/files/modified", { cwd, ignored });
      if (!data.git) {
        filesList.innerHTML = `<div class="empty-state">git unavailable in<br><code>${window.SCOPE.escapeHtml(cwd)}</code><br><small>${window.SCOPE.escapeHtml(data.error || "")}</small></div>`;
        clearDiff();
        return;
      }
      const files = data.files || [];
      if (!files.length) {
        filesList.innerHTML = '<div class="empty-state">no modified files</div>';
        clearDiff();
        return;
      }
      const rank = (f) => (f.status === "untracked" ? 2 : 1);
      const ranked = files.slice().sort((a, b) => rank(a) - rank(b));
      filesList.innerHTML = "";
      const root = {};
      for (const f of ranked) {
        const parts = f.path.split("/");
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i];
          if (!node[p]) node[p] = { __children: {}, __isDir: true };
          node = node[p].__children;
        }
        const name = parts[parts.length - 1];
        node[name] = { __file: f, __isDir: false };
      }
      renderTree(root, filesList, 0);
      const active = ranked.find((f) => f.path === current.file) || ranked[0];
      if (active) { markActive(filesList.querySelector(`[data-file="${CSS.escape(active.path)}"]`)); openFile(active.path); }
    } catch (e) {
      filesList.innerHTML = `<div class="empty-state">error: ${window.SCOPE.escapeHtml(String(e))}</div>`;
    }
  }

  function markActive(el) {
    if (!el) return;
    filesList.querySelectorAll(".file-item.active").forEach((x) => x.classList.remove("active"));
    el.classList.add("active");
  }
  function renderTree(node, container, depth) {
    // Showing ignored files can surface thousands of rows, so collapse folders
    // by default in that mode.
    const collapsed = showIgnored;
    const keys = Object.keys(node).sort((a, b) => {
      const da = node[a].__isDir, db = node[b].__isDir;
      if (da !== db) return da ? -1 : 1;
      return a.localeCompare(b);
    });
    for (const k of keys) {
      const child = node[k];
      if (child.__isDir) {
        const dirRow = document.createElement("div");
        dirRow.className = "tree-dir";
        dirRow.style.paddingLeft = (depth * 14 + 4) + "px";
        const caret = document.createElement("span");
        caret.className = "tree-caret";
        caret.textContent = collapsed ? "▸" : "▾";
        const nm = document.createElement("span");
        nm.className = "tree-name";
        nm.textContent = k + "/";
        dirRow.appendChild(caret);
        dirRow.appendChild(nm);
        const childWrap = document.createElement("div");
        childWrap.className = "tree-children";
        childWrap.style.display = collapsed ? "none" : "";
        dirRow.onclick = () => {
          const hidden = childWrap.style.display === "none";
          childWrap.style.display = hidden ? "" : "none";
          caret.textContent = hidden ? "▾" : "▸";
        };
        container.appendChild(dirRow);
        container.appendChild(childWrap);
        renderTree(child.__children, childWrap, depth + 1);
      } else {
        const f = child.__file;
        const item = document.createElement("div");
        item.className = "file-item";
        item.dataset.file = f.path;
        item.style.paddingLeft = (depth * 14 + 22) + "px";
        const st = document.createElement("span");
        st.className = "st " + f.status;
        st.textContent = STATUS_LABEL[f.status] || f.status;
        const fp = document.createElement("span");
        fp.className = "fp";
        fp.textContent = k + (f.renamed_from ? `  (← ${f.renamed_from})` : "");
        item.appendChild(st);
        item.appendChild(fp);
        item.onclick = () => { markActive(item); openFile(f.path); };
        container.appendChild(item);
      }
    }
  }

  async function openFile(file) {
    const cwd = selectedCwd();
    if (!cwd) return;
    current = { cwd, file, oldBuf: [], newBuf: [], binary: false, dirty: false };
    diffFilename.textContent = file;
    diffStats.textContent = "";
    diffOld.innerHTML = '<div class="dline placeholder"><span class="tx">loading…</span></div>';
    diffNew.innerHTML = "";
    exitEditMode();
    try {
      const { res, data } = await api("/files/diff", { cwd, file });
      if (data.binary) {
        current.binary = true;
        diffOld.innerHTML = '<div class="diff-binary">binary file — diff not shown</div>';
        diffNew.innerHTML = "";
        return;
      }
      current.oldBuf = (data.old || "").split("\n");
      current.newBuf = (data.new || "").split("\n");
      if (current.oldBuf.length && current.oldBuf[current.oldBuf.length - 1] === "") current.oldBuf.pop();
      if (current.newBuf.length && current.newBuf[current.newBuf.length - 1] === "") current.newBuf.pop();
      current.baseOldBuf = current.oldBuf.slice();
      current.baseNewBuf = current.newBuf.slice();
      renderDiff();
    } catch (e) {
      diffOld.innerHTML = `<div class="diff-binary">error: ${window.SCOPE.escapeHtml(String(e))}</div>`;
    }
  }

  // ── Line diff ─────────────────────────────────────────────────────────────
  // Exact LCS DP for small inputs; a patience-style diff (anchor on lines
  // unique to both sides, then recurse) for large ones. The old large-file
  // fallback paired lines by index and marked every row unchanged, so a big
  // file rendered as "no changes" (+0 −0) even when it clearly had some.

  /** Ops (eq/del/add) for one region via the exact LCS DP. */
  function lcsOps(oldL, newL, aLo, aHi, bLo, bHi) {
    const m = aHi - aLo, n = bHi - bLo;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = oldL[aLo + i] === newL[bLo + j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (oldL[aLo + i] === newL[bLo + j]) { ops.push(["eq", aLo + i, bLo + j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["del", aLo + i, null]); i++; }
      else { ops.push(["add", null, bLo + j]); j++; }
    }
    while (i < m) { ops.push(["del", aLo + i, null]); i++; }
    while (j < n) { ops.push(["add", null, bLo + j]); j++; }
    return ops;
  }

  /** Lines occurring exactly once on each side of the region and present in
   *  both — a stable skeleton to anchor the diff on. Returns [oldIdx, newIdx]
   *  pairs forming a common subsequence (LIS over the new-side positions). */
  function uniqueAnchors(oldL, newL, aLo, aHi, bLo, bHi) {
    const aPos = new Map();
    for (let i = aLo; i < aHi; i++) {
      const k = oldL[i];
      aPos.set(k, aPos.has(k) ? -1 : i);
    }
    const bPos = new Map();
    for (let j = bLo; j < bHi; j++) {
      const k = newL[j];
      bPos.set(k, bPos.has(k) ? -1 : j);
    }
    const pairs = [];
    for (const [k, ai] of aPos) {
      if (ai === -1) continue;
      const bj = bPos.get(k);
      if (bj === undefined || bj === -1) continue;
      pairs.push([ai, bj]);
    }
    if (pairs.length < 2) return pairs;
    pairs.sort((x, y) => x[0] - y[0]);
    const tails = [];
    const prev = new Int32Array(pairs.length).fill(-1);
    for (let p = 0; p < pairs.length; p++) {
      const v = pairs[p][1];
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < v) lo = mid + 1; else hi = mid; }
      if (lo > 0) prev[p] = tails[lo - 1];
      tails[lo] = p;
    }
    const out = [];
    let cur = tails.length ? tails[tails.length - 1] : -1;
    while (cur !== -1) { out.push(pairs[cur]); cur = prev[cur]; }
    out.reverse();
    return out;
  }

  /** Index-paired fallback for a region with no usable anchors: matching
   *  offsets are eq, anything else becomes a change. Coarse but honest. */
  function pairOps(oldL, newL, aLo, aHi, bLo, bHi, ops) {
    const max = Math.max(aHi - aLo, bHi - bLo);
    for (let t = 0; t < max; t++) {
      const i = aLo + t < aHi ? aLo + t : null;
      const j = bLo + t < bHi ? bLo + t : null;
      if (i != null && j != null && oldL[i] === newL[j]) ops.push(["eq", i, j]);
      else if (i != null && j != null) { ops.push(["del", i, null]); ops.push(["add", null, j]); }
      else if (i != null) ops.push(["del", i, null]);
      else ops.push(["add", null, j]);
    }
  }

  function patienceOps(oldL, newL) {
    const ops = [];
    const rec = (aLo, aHi, bLo, bHi, depth) => {
      while (aLo < aHi && bLo < bHi && oldL[aLo] === newL[bLo]) { ops.push(["eq", aLo, bLo]); aLo++; bLo++; }
      const tail = [];
      while (aLo < aHi && bLo < bHi && oldL[aHi - 1] === newL[bHi - 1]) { aHi--; bHi--; tail.push([aHi, bHi]); }
      const am = aHi - aLo, bn = bHi - bLo;
      if (am === 0) {
        for (let j = bLo; j < bHi; j++) ops.push(["add", null, j]);
      } else if (bn === 0) {
        for (let i = aLo; i < aHi; i++) ops.push(["del", i, null]);
      } else if (depth > 1500 || !(am * bn <= MAX_CELLS && am + bn <= LINE_CAP)) {
        const anchors = depth > 1500 ? [] : uniqueAnchors(oldL, newL, aLo, aHi, bLo, bHi);
        if (!anchors.length) {
          pairOps(oldL, newL, aLo, aHi, bLo, bHi, ops);
        } else {
          let pa = aLo, pb = bLo;
          for (const [ai, bj] of anchors) {
            rec(pa, ai, pb, bj, depth + 1);
            ops.push(["eq", ai, bj]);
            pa = ai + 1; pb = bj + 1;
          }
          rec(pa, aHi, pb, bHi, depth + 1);
        }
      } else {
        for (const op of lcsOps(oldL, newL, aLo, aHi, bLo, bHi)) ops.push(op);
      }
      for (let k = tail.length - 1; k >= 0; k--) ops.push(["eq", tail[k][0], tail[k][1]]);
    };
    rec(0, oldL.length, 0, newL.length, 0);
    return ops;
  }

  /** Turn an op list into aligned old/new rows with line numbers. */
  function opsToRows(ops, oldL, newL) {
    const rows = [];
    let oldNo = 0, newNo = 0, runningOld = 0, runningNew = 0;
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const dels = pending.filter((o) => o[0] === "del").map((o) => o[1]);
      const adds = pending.filter((o) => o[0] === "add").map((o) => o[2]);
      const kmax = Math.max(dels.length, adds.length);
      for (let k = 0; k < kmax; k++) {
        const oi = dels[k] != null ? dels[k] : null;
        const nj = adds[k] != null ? adds[k] : null;
        const type = oi != null && nj != null ? "change" : oi != null ? "del" : "add";
        rows.push({
          type,
          old: oi != null ? oldL[oi] : null,
          new: nj != null ? newL[nj] : null,
          oldNo: oi != null ? ++oldNo : null,
          newNo: nj != null ? ++newNo : null,
          oldIdx: oi, newIdx: nj,
          oldIns: runningOld, newIns: runningNew,
        });
      }
      pending = [];
    };
    for (const op of ops) {
      if (op[0] === "eq") {
        flush();
        rows.push({ type: "eq", old: oldL[op[1]], new: newL[op[2]], oldNo: ++oldNo, newNo: ++newNo, oldIdx: op[1], newIdx: op[2], oldIns: runningOld, newIns: runningNew });
        runningOld++; runningNew++;
      } else {
        if (op[0] === "del") runningOld++; else runningNew++;
        pending.push(op);
      }
    }
    flush();
    return rows;
  }

  function diffLines(oldL, newL) {
    const m = oldL.length, n = newL.length;
    const small = m + n <= LINE_CAP && !(m > 0 && n > 0 && m * n > MAX_CELLS);
    const ops = small ? lcsOps(oldL, newL, 0, m, 0, n) : patienceOps(oldL, newL);
    return { plain: false, rows: opsToRows(ops, oldL, newL) };
  }

  function makeLine(row, side) {
    const isOld = side === "old";
    const text = isOld ? row.old : row.new;
    const no = isOld ? row.oldNo : row.newNo;
    const div = document.createElement("div");
    const t = row.type === "plain" ? "eq" : row.type;
    div.className = "dline " + (text == null ? "placeholder" : t);
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = no != null ? no : "";
    const tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = text != null ? text : "";
    div.appendChild(ln);
    div.appendChild(tx);
    const hasIdx = isOld ? row.oldIdx != null : row.newIdx != null;
    if (hasIdx) {
      if (!isOld) {
        tx.contentEditable = "true";
        tx.spellcheck = false;
        tx.classList.add("editable");
        tx.addEventListener("focus", () => { activeSide = "new"; });
        tx.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
        tx.addEventListener("input", () => {
          if (row.newIdx != null) {
            current.newBuf[row.newIdx] = tx.textContent;
            current.dirty = true;
            activeSide = "new";
            updateToolbar();
          }
        });
      }
      const b = document.createElement("button");
      b.className = "copy-btn";
      if (isOld) {
        b.textContent = "→";
        b.title = "Copy this line into the working tree (right)";
        b.onclick = (e) => { e.stopPropagation(); copyLine(row, "→"); };
      } else {
        b.textContent = "←";
        b.title = "Copy this line into HEAD (left)";
        b.onclick = (e) => { e.stopPropagation(); copyLine(row, "←"); };
      }
      div.appendChild(b);
    }
    return div;
  }

  function renderDiff() {
    if (current.binary) {
      diffOld.innerHTML = '<div class="diff-binary">binary file — diff not shown</div>';
      diffNew.innerHTML = "";
      return;
    }
    const diff = diffLines(current.oldBuf, current.newBuf);
    let rows = diff.rows;
    // changes-only mode: drop unchanged lines, keep the LCS alignment + line numbers.
    if (!fullView && !diff.plain) rows = rows.filter((r) => r.type !== "eq");
    let add = 0, del = 0;
    diffOld.innerHTML = "";
    diffNew.innerHTML = "";
    for (const row of rows) {
      if (row.type === "add") add++;
      else if (row.type === "del") del++;
      else if (row.type === "change") { add++; del++; }
      diffOld.appendChild(makeLine(row, "old"));
      diffNew.appendChild(makeLine(row, "new"));
    }
    diffStats.innerHTML = `<span class="add">+${add}</span> <span class="del">−${del}</span>`
      + (fullView ? "" : ' <span style="color:var(--muted)">changes only</span>')
      + (current.dirty ? ' <span class="dirty">● unsaved</span>' : '');
  }

  function copyLine(row, dir) {
    if (dir === "→") {
      if (row.newIdx != null) current.newBuf[row.newIdx] = current.oldBuf[row.oldIdx];
      else current.newBuf.splice(row.newIns, 0, current.oldBuf[row.oldIdx]);
      activeSide = "new";
    } else {
      if (row.oldIdx != null) current.oldBuf[row.oldIdx] = current.newBuf[row.newIdx];
      else current.oldBuf.splice(row.oldIns, 0, current.newBuf[row.newIdx]);
      activeSide = "old";
    }
    current.dirty = true;
    renderDiff();
    updateToolbar();
  }

  diffOld.addEventListener("scroll", () => { diffNew.scrollTop = diffOld.scrollTop; });
  diffNew.addEventListener("scroll", () => { diffOld.scrollTop = diffNew.scrollTop; });

  function updateToolbar() {
    btnSave.style.display = current.dirty ? "" : "none";
    btnCancel.style.display = current.dirty ? "" : "none";
  }

  function exitEditMode() {
    updateToolbar();
  }
  async function saveFile() {
    const cwd = selectedCwd();
    const content = (activeSide === "old" ? current.oldBuf : current.newBuf).join("\n");
    try {
      const { res, data } = await api("/files/save", {}, { cwd, file: current.file, content });
      if (!res.ok) {
        diffStats.innerHTML = `<span class="del">save failed: ${window.SCOPE.escapeHtml(data.error || res.status)}</span>`;
        return;
      }
      if (activeSide === "old") current.newBuf = current.oldBuf.slice();
      else current.oldBuf = current.newBuf.slice();
      current.dirty = false;
      current.baseOldBuf = current.oldBuf.slice();
      current.baseNewBuf = current.newBuf.slice();
      diffStats.innerHTML = `<span class="add">saved ${data.bytes ?? 0} bytes (${activeSide === "old" ? "HEAD→file" : "working tree"})</span>`;
      exitEditMode();
      renderDiff();
    } catch (e) {
      diffStats.innerHTML = `<span class="del">save error: ${window.SCOPE.escapeHtml(String(e))}</span>`;
    }
  }

  btnCancel.onclick = () => {
    current.oldBuf = current.baseOldBuf.slice();
    current.newBuf = current.baseNewBuf.slice();
    current.dirty = false;
    renderDiff();
    updateToolbar();
  };
  btnSave.onclick = saveFile;
  btnRefresh.onclick = () => { loadModified(); if (viewMode === "diagram") ensureGraph(true); };

  if (btnWrap) btnWrap.onclick = () => {
    const on = diffGrid.classList.toggle("diff-wrap");
    btnWrap.classList.toggle("active", on);
    btnWrap.textContent = on ? "↩ wrap" : "→ wrap";
  };
  if (btnMode) btnMode.onclick = () => {
    fullView = !fullView;
    btnMode.textContent = fullView ? "full file" : "changes only";
    btnMode.classList.toggle("active", fullView);
    renderDiff();
  };

  // "Files" is the toggle for the file list (there is no separate hide button).
  function updateFilesToggle() {
    if (!btnFilesToggle) return;
    const hidden = filesList.classList.contains("hidden");
    btnFilesToggle.classList.toggle("active", !hidden);
    btnFilesToggle.textContent = (hidden ? "▸" : "▾") + " Files";
    btnFilesToggle.title = hidden ? "Show the file list" : "Hide the file list";
  }
  function setFilesHidden(hidden) {
    filesList.classList.toggle("hidden", hidden);
    if (filesResizer) filesResizer.classList.toggle("hidden", hidden);
    updateFilesToggle();
  }
  function updateIgnoredButton() {
    if (!btnIgnored) return;
    btnIgnored.classList.toggle("active", showIgnored);
    btnIgnored.textContent = showIgnored ? "gitignore: shown" : "gitignore: hidden";
    btnIgnored.title = showIgnored
      ? "Showing files matched by .gitignore — click to hide them"
      : "Hiding files matched by .gitignore — click to show them";
  }
  if (btnFilesToggle) btnFilesToggle.onclick = () => setFilesHidden(!filesList.classList.contains("hidden"));
  if (btnIgnored) btnIgnored.onclick = () => {
    showIgnored = !showIgnored;
    updateIgnoredButton();
    loadModified();
  };

  if (filesResizer) {
    const MIN = 140, MAX = 700;
    filesResizer.addEventListener("mousedown", (e) => {
      if (filesList.classList.contains("hidden")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = filesList.getBoundingClientRect().width;
      filesResizer.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const onMove = (ev) => {
        const w = Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX)));
        filesList.style.setProperty("--files-list-w", Math.round(w) + "px");
      };
      const onUp = () => {
        filesResizer.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  if (diffResizer) {
    let dragging = false;
    diffResizer.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const grid = diffOldCol.parentElement;
      const rect = grid.getBoundingClientRect();
      let pct = ((e.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(20, Math.min(80, pct));
      diffOldCol.style.flex = `0 0 ${pct}%`;
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Review → Diagram: dependency graph with a change overlay
  // ════════════════════════════════════════════════════════════════════════
  // Answers "what did this change touch, and what could it break?". Nodes are
  // files (or folders); changed nodes glow; clicking a node inspects its churn,
  // its dependents (fan-in) and jumps straight to the diff. "impact" highlights
  // the transitive blast radius of the selected node. Review progress is kept
  // per working directory so a long review can be resumed later.
  const esc = window.SCOPE.escapeHtml;
  const STATUS_META = {
    modified: { cls: "modified" }, added: { cls: "added" }, deleted: { cls: "deleted" },
    untracked: { cls: "untracked" }, renamed: { cls: "renamed" },
  };
  const STATUS_RANK = { added: 5, modified: 4, renamed: 3, untracked: 2, deleted: 1 };
  const REVIEW_STORE = "scope-review-done";

  const diffPane = $(".files-diff");
  const diagramSvg = $("#diagram-svg");
  const diagramCanvas = $("#diagram-canvas");
  const diagramLegend = $("#diagram-legend");
  const diagramSide = $("#diagram-side");
  const diagramStatsEl = $("#diagram-stats");
  const diagramSearchIn = $("#diagram-search");
  const diagramChangedEl = $("#diagram-changed-only");
  const diagramImpactEl = $("#diagram-impact");
  const btnDiagram = $("#btn-files-diagram");

  let viewMode = "diagram"; // "diff" | "diagram" — the diagram is the default view
  let graph = null;         // last /files/graph payload
  let graphCwd = "";
  let graphLoading = false;
  let gran = "files";       // "files" | "modules"
  let selNodeId = null;
  let diagramFilter = "";
  let diagramChangedOnly = false;
  let diagramImpact = false;
  const LAY = { nodes: [], edges: [], clusters: [], folders: [], w: 800, h: 560, tx: 0, ty: 0, scale: 1 };

  // ── Review progress (persisted per cwd) ──────────────────────────────────
  function reviewedFor(cwd) {
    try { return new Set(JSON.parse(localStorage.getItem(REVIEW_STORE) || "{}")[cwd] || []); }
    catch { return new Set(); }
  }
  function isReviewed(path) { return reviewedFor(selectedCwd()).has(path); }
  function toggleReviewed(path, on) {
    try {
      const all = JSON.parse(localStorage.getItem(REVIEW_STORE) || "{}");
      const cwd = selectedCwd();
      const set = new Set(all[cwd] || []);
      if (on) set.add(path); else set.delete(path);
      all[cwd] = [...set];
      localStorage.setItem(REVIEW_STORE, JSON.stringify(all));
    } catch { /* storage unavailable — review flags are best-effort */ }
  }

  function dominantStatus(statuses) {
    let best = null, bestN = -1;
    for (const [st, n] of Object.entries(statuses || {})) {
      if (n > bestN || (n === bestN && (STATUS_RANK[st] || 0) > (STATUS_RANK[best] || 0))) { best = st; bestN = n; }
    }
    return best;
  }
  function riskOf(item) { return item.fanIn * 3 + (item.add || 0) + (item.del || 0); }
  function riskLabel(score) {
    return score >= 60 ? { word: "high", cls: "high" }
      : score >= 15 ? { word: "med", cls: "med" }
      : { word: "low", cls: "low" };
  }

  // ── Fetch + model ─────────────────────────────────────────────────────────
  async function ensureGraph(force) {
    const cwd = selectedCwd();
    if (!cwd) { graph = null; graphCwd = ""; renderDiagram(true); return; }
    if (!force && graph && graphCwd === cwd) return;
    if (graphLoading) return;
    graphLoading = true;
    if (diagramStatsEl) diagramStatsEl.textContent = "building graph…";
    try {
      const { data } = await api("/files/graph", { cwd });
      graph = data;
      graphCwd = cwd;
    } catch (e) {
      graph = null;
      if (diagramStatsEl) diagramStatsEl.textContent = "graph error";
    } finally {
      graphLoading = false;
    }
    renderDiagram(true);
  }

  function graphModel() {
    if (!graph) return { nodes: [], edges: [], total: 0, capped: false };
    const useFiles = gran === "files";
    const srcNodes = useFiles ? (graph.fileNodes || []) : (graph.modules || []);
    const byId = new Map();
    for (const m of srcNodes) {
      const id = useFiles ? m.path : m.id;
      const status = useFiles ? (m.status || null) : dominantStatus(m.statuses);
      byId.set(id, {
        id, full: id, label: id === "." ? "(root)" : (id.split("/").pop() || id),
        module: useFiles ? m.module : m.id,
        loc: m.loc || 0,
        changed: useFiles ? !!status : (m.changedFiles || 0) > 0,
        status,
        add: m.add || 0, del: m.del || 0,
        fanIn: m.fanIn || 0, fanOut: m.fanOut || 0,
        changedCount: useFiles ? (status ? 1 : 0) : (m.changedFiles || 0),
      });
    }
    let edges = (useFiles ? (graph.fileEdges || []) : (graph.edges || []))
      .filter((e) => byId.has(e.from) && byId.has(e.to));
    const CAP = useFiles ? 220 : 320;
    const total = byId.size;
    if (total > CAP) {
      const ranked = [...byId.values()].sort((a, b) =>
        (Number(b.changed) - Number(a.changed)) || (b.fanIn + b.fanOut - a.fanIn - a.fanOut) || (b.loc - a.loc));
      const keep = new Set(ranked.slice(0, CAP).map((n) => n.id));
      for (const id of [...byId.keys()]) if (!keep.has(id)) byId.delete(id);
      edges = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
    }
    let nodes = [...byId.values()];
    const f = diagramFilter.trim().toLowerCase();
    if (f) nodes = nodes.filter((n) => n.full.toLowerCase().includes(f) || n.label.toLowerCase().includes(f));
    if (diagramChangedOnly) nodes = nodes.filter((n) => n.changed);
    const ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes, edges, total, capped: total > CAP };
  }

  // ── Semantic "architecture" layout ────────────────────────────────────────
  // Instead of bare dependency tiers, blocks are grouped into functional AREAS
  // inferred from their path — GUI / frontend, server / API, core / shared,
  // database, CLI, tests, docs, config — and each area is drawn as a labelled
  // band. Bands are ordered top→bottom by their dependency depth (entry points
  // above what they pull in) and, within a band, files are clustered by folder.
  // The result reads as an architecture map rather than a raw tier list.
  const CATEGORY_META = {
    gui: { label: "GUI / Frontend", color: "var(--purple)", order: 0 },
    api: { label: "Server / API", color: "var(--accent)", order: 1 },
    core: { label: "Core / Shared", color: "var(--green)", order: 2 },
    data: { label: "Database / Data", color: "var(--amber)", order: 3 },
    cli: { label: "CLI", color: "var(--accent)", order: 4 },
    config: { label: "Config", color: "var(--muted)", order: 5 },
    other: { label: "Other", color: "var(--muted)", order: 6 },
    tests: { label: "Tests", color: "var(--orange)", order: 7 },
    docs: { label: "Docs", color: "var(--muted)", order: 8 },
  };
  const CATEGORY_FALLBACK = { label: "Other", color: "var(--muted)", order: 9 };

  // Best-effort "what is this file?" from its path. Order matters: tests / docs /
  // config are checked before code areas, and GUI before core (a component under
  // src/ is GUI, not core).
  function classifyPath(p) {
    const lower = String(p || "").toLowerCase();
    const segs = lower.split("/");
    const base = segs[segs.length - 1] || "";
    if (segs.some((s) => ["test", "tests", "spec", "specs", "__tests__", "e2e", "fixtures"].includes(s)) ||
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return "tests";
    if (segs[0] === "docs" || /^readme/.test(base) || /\.(md|mdx|rst|txt)$/.test(base)) return "docs";
    if (segs[0] === "config" || segs[0] === "configs" || segs[0] === ".github" || segs[0] === ".vscode" ||
        /(^|[._-])(config|settings|env)\./.test(base) || /\.(json|ya?ml|toml|ini)$/.test(base)) return "config";
    if (/(^|[._/-])(db|database|sqlite|postgres|mysql|mongo|migrations?|schema|models?|orm|prisma|knex|sequelize|redis|repositor(y|ies))([._/-]|$)/.test(lower)) return "data";
    if (/(^|\/)(public|static|assets?|ui|frontend|web|views?|pages?|components?|styles?|css|templates?|renderer|electron|launcher)(\/|$)/.test(lower) ||
        /\.(jsx|tsx|vue|svelte|html|css|scss|sass|less)$/.test(base) ||
        /(^|[._/-])(app|main|index)\.(js|jsx|ts|tsx|vue|svelte|html)$/.test(base)) return "gui";
    if (/(^|\/)(api|server|backend|routes?|controllers?|handlers?|endpoints?|services?|middleware|graphql|resolvers?)(\/|$)/.test(lower) ||
        /(^|[._/-])(server|api|app)\.(ts|js|tsx|jsx|py|go|rs)$/.test(base)) return "api";
    if (/(^|\/)(cli|bin|cmd|commands?|scripts?|tools?)(\/|$)/.test(lower)) return "cli";
    if (/(^|\/)(shared|common|core|libs?|utils?|helpers?|internal|src)(\/|$)/.test(lower)) return "core";
    return "other";
  }

  // Second line of an area-block heading: how many of its files changed.
  function bandSubLabel(total, changedN) {
    const unit = gran === "files"
      ? (total === 1 ? "file" : "files")
      : (total === 1 ? "folder" : "folders");
    return changedN ? `${changedN} of ${total} changed` : `${total} ${unit}`;
  }

  function clusteredLayout(nodes, edges) {
    const n = nodes.length;
    LAY.clusters = [];
    LAY.folders = [];
    if (!n) return;
    const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
    const inAdj = nodes.map(() => []);
    const seen = new Set();
    for (const e of edges) {
      const a = idx.get(e.from), b = idx.get(e.to);
      if (a == null || b == null || a === b) continue;
      const key = a + ">" + b;
      if (seen.has(key)) continue;
      seen.add(key);
      inAdj[b].push(a);
    }
    // Dependency depth: entry points are depth 0, what they import is deeper.
    // Cycles are handled by ignoring back edges.
    const state = new Uint8Array(n);
    const rank = new Int32Array(n);
    const visit = (u) => {
      if (state[u] === 2) return rank[u];
      if (state[u] === 1) return -1;
      state[u] = 1;
      let r = 0;
      for (const w of inAdj[u]) r = Math.max(r, visit(w) + 1);
      state[u] = 2;
      rank[u] = r;
      return r;
    };
    for (let i = 0; i < n; i++) if (state[i] === 0) visit(i);

    const byCat = new Map();
    nodes.forEach((nd, i) => {
      const c = classifyPath(nd.full);
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(i);
    });

    const sizes = nodes.map((nd) => nodeSize(nd));
    const folderKeyOf = (nd) => {
      if (gran === "files") return nd.module;
      const i = nd.full.lastIndexOf("/");
      return i < 0 ? "." : nd.full.slice(0, i);
    };

    const padX = 16, headH = 38, padBottom = 16, folderLabelH = 15;
    const groupGap = 20, nodeGapY = 8, rowGap = 14, margin = 30;
    const bandGapX = 26, bandGapY = 24;
    // Each area wraps its folder groups to roughly this width; areas are then
    // shelf-packed into a 2-D grid against the canvas aspect (below).
    const areaCapW = Math.max(LAY.w * 1.4, 1000);

    // Build each area's rows of folder groups.
    const bands = [];
    for (const key of byCat.keys()) {
      const ids = byCat.get(key);
      const groupsMap = new Map();
      for (const i of ids) {
        const gk = folderKeyOf(nodes[i]);
        if (!groupsMap.has(gk)) groupsMap.set(gk, []);
        groupsMap.get(gk).push(i);
      }
      const groups = [...groupsMap.entries()].map(([gk, gids]) => {
        gids.sort((a, b) => nodes[a].label.localeCompare(nodes[b].label));
        const w = Math.max(70, ...gids.map((i) => sizes[i].w));
        const h = folderLabelH + gids.reduce((s, i) => s + sizes[i].h + nodeGapY, 0) - nodeGapY;
        return { gk, gids, w, h };
      }).sort((a, b) => a.gk.localeCompare(b.gk));
      const rows = [];
      let row = [], rowW = 0, rowH = 0;
      for (const g of groups) {
        if (row.length && rowW + groupGap + g.w > areaCapW - padX * 2) {
          rows.push({ row, w: rowW, h: rowH });
          row = []; rowW = 0; rowH = 0;
        }
        rowW += (row.length ? groupGap : 0) + g.w;
        rowH = Math.max(rowH, g.h);
        row.push(g);
      }
      if (row.length) rows.push({ row, w: rowW, h: rowH });
      if (!rows.length) continue;
      const innerW = Math.max(...rows.map((r) => r.w));
      const bandH = headH + rows.reduce((s, r) => s + r.h, 0) + rowGap * (rows.length - 1) + padBottom;
      const depth = ids.map((i) => rank[i]).sort((a, b) => a - b)[Math.floor(ids.length / 2)];
      const meta = CATEGORY_META[key] || CATEGORY_FALLBACK;
      // The heading is two lines now (area name / change summary), so the band
      // is widened to fit the wider line and the summary can never spill out.
      const changedN = ids.filter((i) => nodes[i].changed).length;
      const sub = bandSubLabel(ids.length, changedN);
      const headerW = Math.min(460, Math.max(meta.label.length * 6.9 + 26, sub.length * 5.2 + 26));
      const bandW = Math.max(innerW + padX * 2, headerW);
      bands.push({ key, meta, ids, rows, innerW, sub, bandW, bandH, depth });
    }
    if (!bands.length) return;
    // Entry-point areas first; the fixed semantic order breaks ties when a repo
    // has few resolved imports (all depths 0).
    bands.sort((a, b) => (a.depth - b.depth) || (a.meta.order - b.meta.order));

    // Shelf-pack the areas into rows. Several row widths are tried and the one
    // whose bounding box is closest to the canvas aspect ratio wins, so the
    // diagram fills the viewport in 2-D instead of forming one long strip.
    const canvasAspect = (LAY.w > 0 && LAY.h > 0) ? (LAY.w / LAY.h) : 1.6;
    const pack = (targetW) => {
      const rows = [];
      let cur = [], curW = 0, curH = 0;
      for (const b of bands) {
        if (cur.length && curW + bandGapX + b.bandW > targetW) {
          rows.push({ items: cur, w: curW, h: curH });
          cur = []; curW = 0; curH = 0;
        }
        curW += (cur.length ? bandGapX : 0) + b.bandW;
        curH = Math.max(curH, b.bandH);
        cur.push(b);
      }
      if (cur.length) rows.push({ items: cur, w: curW, h: curH });
      const W = Math.max(...rows.map((r) => r.w), 1);
      const H = rows.reduce((s, r) => s + r.h, 0) + bandGapY * (rows.length - 1);
      return { rows, W, H };
    };
    let packed = null;
    for (let i = 0; i <= 12; i++) {
      const p = pack(areaCapW * (0.55 + i * 0.25));
      const score = Math.abs(Math.log((p.W / p.H) / canvasAspect));
      if (!packed || score < packed.score) packed = { ...p, score };
    }

    let y = margin;
    for (const row of packed.rows) {
      let x = margin + Math.max(0, (packed.W - row.w) / 2);
      for (const band of row.items) {
        const bx = x;
        let gy = y + headH;
        for (const r of band.rows) {
          let gx = bx + padX + (band.innerW - r.w) / 2;
          for (const g of r.row) {
            LAY.folders.push({ label: g.gk, x: gx, y: gy, w: g.w });
            let ny = gy + folderLabelH;
            for (const i of g.gids) {
              nodes[i].x = gx + g.w / 2;
              nodes[i].y = ny + sizes[i].h / 2;
              ny += sizes[i].h + nodeGapY;
            }
            gx += g.w + groupGap;
          }
          gy += r.h + rowGap;
        }
        LAY.clusters.push({
          key: band.key, label: band.meta.label, color: band.meta.color,
          x: bx, y, w: band.bandW, h: band.bandH,
          count: band.ids.length, changed: band.ids.filter((i) => nodes[i].changed).length,
        });
        x += band.bandW + bandGapX;
      }
      y += row.h + bandGapY;
    }
    LAY.w = Math.max(LAY.w, packed.W + margin * 2);
    LAY.h = Math.max(LAY.h, y - bandGapY + margin);
  }

  // ── Blocks: rectangular nodes sized to fit their label ────────────────────
  // A folder block is a collection of files, so it carries a second, smaller
  // line: how many files inside it changed.
  function nodeSubLabel(nd) {
    if (gran !== "modules" || !nd.changedCount) return "";
    return `${nd.changedCount} changed`;
  }
  function nodeSize(nd) {
    const label = window.SCOPE.trunc(nd.label, 26);
    const sub = nodeSubLabel(nd);
    // The sub-line renders at 7.5px (~4.5px/char); size to the wider line so
    // neither the name nor the summary can spill past the box edge.
    const textW = Math.max(label.length * 6.4, sub ? sub.length * 4.9 : 0);
    const w = Math.max(58, Math.min(240, textW + 18));
    const h = sub ? 32 : (gran === "files" ? 22 : 26);
    return { w, h };
  }
  // Which side of a block an edge should leave from, given where the other end
  // sits: vertical sides for a mostly-vertical hop, horizontal ones otherwise.
  function anchorSide(nd, tx, ty) {
    const dx = tx - nd.x, dy = ty - nd.y;
    if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? "bottom" : "top";
    return dx >= 0 ? "right" : "left";
  }
  function sidePoint(nd, side) {
    const { w, h } = nodeSize(nd);
    if (side === "top") return { x: nd.x, y: nd.y - h / 2 };
    if (side === "bottom") return { x: nd.x, y: nd.y + h / 2 };
    if (side === "left") return { x: nd.x - w / 2, y: nd.y };
    return { x: nd.x + w / 2, y: nd.y };
  }
  // Orthogonal (Manhattan) connector: leaves the source edge, runs to a single
  // mid-line, turns 90° and enters the target edge — square corners only.
  function orthoPath(a, b) {
    const sa = anchorSide(a, b.x, b.y);
    const sb = anchorSide(b, a.x, a.y);
    const p1 = sidePoint(a, sa);
    const p2 = sidePoint(b, sb);
    const f = (n) => n.toFixed(1);
    if (sa === "top" || sa === "bottom") {
      if (Math.abs(p1.x - p2.x) < 0.5) return `M ${f(p1.x)} ${f(p1.y)} L ${f(p2.x)} ${f(p2.y)}`;
      const midY = (p1.y + p2.y) / 2;
      return `M ${f(p1.x)} ${f(p1.y)} L ${f(p1.x)} ${f(midY)} L ${f(p2.x)} ${f(midY)} L ${f(p2.x)} ${f(p2.y)}`;
    }
    if (Math.abs(p1.y - p2.y) < 0.5) return `M ${f(p1.x)} ${f(p1.y)} L ${f(p2.x)} ${f(p2.y)}`;
    const midX = (p1.x + p2.x) / 2;
    return `M ${f(p1.x)} ${f(p1.y)} L ${f(midX)} ${f(p1.y)} L ${f(midX)} ${f(p2.y)} L ${f(p2.x)} ${f(p2.y)}`;
  }

  function fitView() {
    const nodes = LAY.nodes;
    if (!nodes.length) { LAY.tx = 0; LAY.ty = 0; LAY.scale = 1; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (LAY.clusters && LAY.clusters.length) {
      for (const c of LAY.clusters) {
        minX = Math.min(minX, c.x - 12); minY = Math.min(minY, c.y - 12);
        maxX = Math.max(maxX, c.x + c.w + 12); maxY = Math.max(maxY, c.y + c.h + 12);
      }
    } else {
      for (const nd of nodes) {
        const sz = nodeSize(nd);
        minX = Math.min(minX, nd.x - sz.w / 2 - 14); minY = Math.min(minY, nd.y - sz.h / 2 - 14);
        maxX = Math.max(maxX, nd.x + sz.w / 2 + 14); maxY = Math.max(maxY, nd.y + sz.h / 2 + 14);
      }
    }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const s = Math.min(LAY.w / bw, LAY.h / bh, 1.8);
    LAY.scale = s;
    LAY.tx = (LAY.w - bw * s) / 2 - minX * s;
    LAY.ty = (LAY.h - bh * s) / 2 - minY * s;
  }

  function transitiveDependents(selId, edges) {
    const rev = new Map();
    for (const e of edges) {
      const arr = rev.get(e.to);
      if (arr) arr.push(e.from); else rev.set(e.to, [e.from]);
    }
    const out = new Set();
    const q = [selId];
    while (q.length) {
      for (const up of rev.get(q.pop()) || []) if (!out.has(up)) { out.add(up); q.push(up); }
    }
    return out;
  }

  function applyTransform() {
    const g = diagramSvg.querySelector(".dzoom");
    if (g) g.setAttribute("transform", `translate(${LAY.tx.toFixed(1)},${LAY.ty.toFixed(1)}) scale(${LAY.scale.toFixed(3)})`);
  }

  function renderDiagram(reheat) {
    if (!graph) {
      diagramSvg.innerHTML = "";
      if (diagramStatsEl) diagramStatsEl.textContent = "";
      renderDiagramSide();
      return;
    }
    const model = graphModel();
    const ids = new Set(model.nodes.map((n) => n.id));
    const same = !reheat && LAY.nodes.length === model.nodes.length && LAY.nodes.every((n) => ids.has(n.id));
    if (!same) {
      LAY.w = diagramCanvas.clientWidth || 800;
      LAY.h = diagramCanvas.clientHeight || 560;
      LAY.nodes = model.nodes;
      LAY.edges = model.edges;
      clusteredLayout(LAY.nodes, LAY.edges);
      fitView();
    } else {
      const fresh = new Map(model.nodes.map((n) => [n.id, n]));
      for (const n of LAY.nodes) {
        const m = fresh.get(n.id);
        if (m) Object.assign(n, { status: m.status, changed: m.changed, add: m.add, del: m.del, fanIn: m.fanIn, fanOut: m.fanOut, changedCount: m.changedCount });
      }
      LAY.edges = model.edges;
    }
    if (selNodeId && !ids.has(selNodeId)) selNodeId = null;
    const sel = LAY.nodes.find((n) => n.id === selNodeId) || null;
    const impacted = (diagramImpact && sel) ? transitiveDependents(sel.id, LAY.edges) : null;
    const byId = new Map(LAY.nodes.map((n) => [n.id, n]));
    LAY.byId = byId; // kept so a live drag can re-route the edges it touches

    // Area bands (drawn behind everything) + the folder labels inside them.
    // Each band heading is two lines — the area name, then the change summary
    // in a smaller font — both kept inside the band's rounded header strip.
    let clusterHtml = "";
    for (const c of (LAY.clusters || [])) {
      const pad = 26;
      const maxT = Math.max(8, Math.floor((c.w - pad) / 6.9));
      const maxS = Math.max(8, Math.floor((c.w - pad) / 5.2));
      const sub = c.sub || bandSubLabel(c.count, c.changed);
      clusterHtml += `<g class="dcluster">`
        + `<rect class="dcluster-bg" x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" width="${c.w.toFixed(1)}" height="${c.h.toFixed(1)}" rx="10"/>`
        + `<rect class="dcluster-head" x="${(c.x + 6).toFixed(1)}" y="${(c.y + 6).toFixed(1)}" width="${(c.w - 12).toFixed(1)}" height="28" rx="7" fill="${c.color}" fill-opacity="0.14"/>`
        + `<text class="dcluster-title" x="${(c.x + 13).toFixed(1)}" y="${(c.y + 18).toFixed(1)}" fill="${c.color}">${esc(window.SCOPE.trunc(c.label, maxT))}</text>`
        + `<text class="dcluster-sub" x="${(c.x + 13).toFixed(1)}" y="${(c.y + 30).toFixed(1)}" fill="${c.color}">${esc(window.SCOPE.trunc(sub, maxS))}</text>`
        + `</g>`;
    }
    for (const f of (LAY.folders || [])) {
      // Keep the folder label inside its own slot: no +slack, so it can never
      // reach past the band's inner edge.
      const maxChars = Math.max(8, Math.floor(f.w / 5.8));
      clusterHtml += `<text class="dfolder" x="${f.x.toFixed(1)}" y="${(f.y + 11).toFixed(1)}">${esc(window.SCOPE.trunc(f.label, maxChars))}</text>`;
    }

    let edgeHtml = "";
    for (const e of LAY.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const hot = impacted && (impacted.has(e.from) || (sel && e.from === sel.id));
      edgeHtml += `<path class="dedge${hot ? " hot" : ""}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${orthoPath(a, b)}" fill="none" vector-effect="non-scaling-stroke" marker-end="url(#d-arrow)"/>`;
    }
    let nodeHtml = "";
    for (const nd of LAY.nodes) {
      const { w, h } = nodeSize(nd);
      const cls = ["dnode"];
      if (nd.changed) cls.push("changed", "st-" + (nd.status || "modified"));
      if (isReviewed(nd.full)) cls.push("done");
      if (sel && nd.id === sel.id) cls.push("sel");
      else if (impacted && impacted.has(nd.id)) cls.push("impact");
      else if (sel || impacted) cls.push("dim");
      const tip = `${nd.full}${nd.changed ? " · " + (nd.status || "modified") : ""}${nd.fanIn ? " · " + nd.fanIn + " dependents" : ""}${isReviewed(nd.full) ? " · reviewed" : ""}`;
      const sub = nodeSubLabel(nd);
      nodeHtml += `<g class="${cls.join(" ")}" data-node="${esc(nd.id)}" transform="translate(${nd.x.toFixed(1)},${nd.y.toFixed(1)})">`
        + `<rect class="dbox" x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(0)}" height="${h}" rx="4"/>`
        + (nd.changed ? `<rect class="dbar" x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="3" height="${h}"/>` : "")
        + `<title>${esc(tip)}</title>`
        + `<text y="${sub ? -3 : 3.5}">${esc(window.SCOPE.trunc(nd.label, 26))}</text>`
        + (sub ? `<text class="dsub" y="10">${esc(window.SCOPE.trunc(sub, 20))}</text>` : "")
        + `</g>`;
    }
    diagramSvg.setAttribute("viewBox", `0 0 ${LAY.w} ${LAY.h}`);
    diagramSvg.innerHTML = `<defs><marker id="d-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>`
      + `<g class="dzoom" transform="translate(${LAY.tx.toFixed(1)},${LAY.ty.toFixed(1)}) scale(${LAY.scale.toFixed(3)})">${clusterHtml}${edgeHtml}${nodeHtml}</g>`;
    renderLegend();
    renderDiagramSide();
    const st = graph.stats || {};
    if (diagramStatsEl) {
      diagramStatsEl.textContent = `${model.nodes.length}/${model.total} ${gran === "files" ? "files" : "folders"}`
        + ` · ${(LAY.clusters || []).length} areas`
        + ` · ${st.changedFiles || 0} changed (+${st.add || 0} −${st.del || 0})`
        + (model.capped ? " · capped" : "");
    }
  }

  function renderLegend() {
    if (!diagramLegend) return;
    const changed = (graph && graph.changed) || [];
    const reviewed = changed.filter((c) => isReviewed(c.path)).length;
    diagramLegend.innerHTML =
      `<span class="dlg"><span class="dsw changed"></span>changed</span>`
      + `<span class="dlg"><span class="dsw modified"></span>modified</span>`
      + `<span class="dlg"><span class="dsw added"></span>added</span>`
      + `<span class="dlg"><span class="dsw deleted"></span>deleted</span>`
      + `<span class="dlg"><span class="dsw done"></span>reviewed ${reviewed}/${changed.length}</span>`;
  }

  // ── Side panel ─────────────────────────────────────────────────────────────
  function renderDiagramSide() {
    if (!diagramSide) return;
    if (!graph) { diagramSide.innerHTML = '<div class="dside-sub" style="padding:12px">No dependency data.</div>'; return; }
    const model = graphModel();
    const node = model.nodes.find((n) => n.id === selNodeId) || null;
    diagramSide.innerHTML = node ? nodeSideHTML(node, model) : overviewSideHTML(model);
    bindSidePanel(model);
  }

  function overviewSideHTML(model) {
    const st = graph.stats || {};
    const changed = graph.changed || [];
    const done = changed.filter((c) => isReviewed(c.path)).length;
    const pct = changed.length ? Math.round((done / changed.length) * 100) : 0;
    const head = graph.head;
    let html = "";
    if (head && head.subject) {
      html += `<div class="dside-head"><div class="dside-kicker">review baseline</div>`
        + `<div class="dside-title">${esc(window.SCOPE.trunc(head.subject, 90))}</div>`
        + `<div class="dside-sub">${esc(head.hash || "")} · ${esc(head.author || "")} · ${esc(head.date || "")}</div></div>`;
    }
    html += `<div class="dside-section"><div class="dside-kicker">working tree</div>`
      + `<div class="dstats-row"><span class="dstat">${st.changedFiles || 0} changed</span>`
      + `<span class="dstat add">+${st.add || 0}</span><span class="dstat del">−${st.del || 0}</span>`
      + `<span class="dstat">${st.modules || 0} folders</span></div>`
      + `<div class="dprogress" title="Changed files you have marked reviewed"><div class="dprogress-bar" style="width:${pct}%"></div></div>`
      + `<div class="dside-sub">${done} of ${changed.length} changed files reviewed</div></div>`;
    if (LAY.clusters && LAY.clusters.length) {
      html += `<div class="dside-section"><div class="dside-kicker">areas · auto-detected</div>`
        + LAY.clusters.map((c) => `<div class="darea"><span class="dsw" style="background:${c.color}"></span>`
          + `<span class="drel-name">${esc(c.label)}</span>`
          + `<span class="drel-count">${c.count}${c.changed ? " · " + c.changed + " changed" : ""}</span></div>`).join("")
        + `</div>`;
    }
    html += `<div class="dside-section"><div class="dside-kicker">review queue · highest risk first</div>`;
    html += changed.length ? changed.map((c) => changedRowHTML(c, true)).join("") : `<div class="dside-sub">Nothing changed in the working tree.</div>`;
    html += `</div>`;
    const hot = [...model.nodes].filter((n) => n.fanIn > 0).sort((a, b) => b.fanIn - a.fanIn).slice(0, 8);
    html += `<div class="dside-section"><div class="dside-kicker">hot spots · most depended-on</div>`
      + (hot.length ? hot.map((n) => `<div class="drel" data-goto="${esc(n.id)}"><span class="drel-name">${esc(n.full)}</span><span class="drel-count">${n.fanIn} in</span></div>`).join("")
        : `<div class="dside-sub">No local imports resolved.</div>`)
      + `</div>`;
    return html;
  }

  function changedRowHTML(c, showModule) {
    const meta = STATUS_META[c.status] || { cls: "modified" };
    const risk = riskLabel(riskOf({ fanIn: c.fanIn, add: c.add, del: c.del }));
    const done = isReviewed(c.path);
    return `<div class="dchanged${done ? " done" : ""}">`
      + `<label class="dcheck-wrap" title="Mark reviewed"><input type="checkbox" data-review="${esc(c.path)}"${done ? " checked" : ""}></label>`
      + `<span class="st ${meta.cls}">${(STATUS_LABEL[c.status] || "?").toUpperCase()}</span>`
      + `<span class="dchanged-path" data-open="${esc(c.path)}" title="Open the diff for ${esc(c.path)}">${esc(c.path)}</span>`
      + (showModule ? `<span class="dchanged-mod">${esc(c.module)}</span>` : "")
      + `<span class="dchanged-stat"><span class="add">+${c.add || 0}</span> <span class="del">−${c.del || 0}</span></span>`
      + `<span class="drisk ${risk.cls}" title="fan-in ${c.fanIn} · churn ${(c.add || 0) + (c.del || 0)}">${risk.word}</span>`
      + (c.fanIn ? `<span class="dfanin" title="${c.fanIn} files import this">⤣${c.fanIn}</span>` : "")
      + `</div>`;
  }

  function nodeSideHTML(node, model) {
    const isFile = gran === "files";
    const meta = node.status ? STATUS_META[node.status] : null;
    const done = isReviewed(node.full);
    let html = `<div class="dside-head"><div class="dside-kicker">${isFile ? "file" : "folder"}</div>`
      + `<div class="dside-title" title="${esc(node.full)}">${esc(node.full)}</div>`
      + `<div class="dside-sub">${node.loc} lines · ${node.fanIn} dependents · ${node.fanOut} imports</div></div>`;
    html += `<div class="dside-section dside-actions">`;
    if (isFile) html += `<button class="btn-sm" id="dside-open" type="button">⇄ open diff</button>`;
    if (node.changed) html += `<label class="dside-review"><input type="checkbox" data-review="${esc(node.full)}"${done ? " checked" : ""}> reviewed</label>`;
    html += `</div>`;
    if (node.changed) {
      html += `<div class="dside-section"><div class="dside-kicker">changes</div><div class="dstats-row">`
        + (meta ? `<span class="st ${meta.cls}">${(STATUS_LABEL[node.status] || "?").toUpperCase()}</span>` : "")
        + `<span class="dstat add">+${node.add}</span><span class="dstat del">−${node.del}</span>`
        + (node.fanIn ? `<span class="dstat warn">${node.fanIn} files depend on this</span>` : "")
        + `</div></div>`;
    }
    if (!isFile) {
      const inMod = (graph.changed || []).filter((c) => c.module === node.id);
      html += `<div class="dside-section"><div class="dside-kicker">modified files here (${inMod.length})</div>`
        + (inMod.length ? inMod.map((c) => changedRowHTML(c, false)).join("") : `<div class="dside-sub">No modified files in this folder.</div>`)
        + `</div>`;
      const files = (graph.fileNodes || []).filter((f) => f.module === node.id);
      html += `<div class="dside-section"><div class="dside-kicker">source files (${files.length})</div>`
        + files.slice(0, 40).map((f) => `<div class="drel" data-goto="${esc(f.path)}"><span class="drel-name">${esc(f.path)}</span>`
          + (f.status ? `<span class="st ${(STATUS_META[f.status] || {}).cls || "modified"}">${(STATUS_LABEL[f.status] || "?").toUpperCase()}</span>` : "") + `</div>`).join("")
        + `</div>`;
    }
    const imports = LAY.edges.filter((e) => e.from === node.id).map((e) => e.to);
    const dependents = LAY.edges.filter((e) => e.to === node.id).map((e) => e.from);
    html += relationSection("imports", imports);
    html += relationSection("dependents · what this could break", dependents);
    return html;
  }

  function relationSection(title, ids) {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return `<div class="dside-section"><div class="dside-kicker">${title}</div><div class="dside-sub">none resolved</div></div>`;
    return `<div class="dside-section"><div class="dside-kicker">${title} (${uniq.length})</div>`
      + uniq.slice(0, 60).map((id) => `<div class="drel" data-goto="${esc(id)}"><span class="drel-name">${esc(id)}</span></div>`).join("")
      + `</div>`;
  }

  function bindSidePanel(model) {
    diagramSide.querySelectorAll("[data-open]").forEach((el) => {
      el.onclick = () => openDiff(el.getAttribute("data-open"));
    });
    diagramSide.querySelectorAll("[data-review]").forEach((el) => {
      el.onchange = () => { toggleReviewed(el.getAttribute("data-review"), el.checked); renderDiagram(); };
    });
    const openBtn = diagramSide.querySelector("#dside-open");
    if (openBtn && selNodeId) openBtn.onclick = () => openDiff(selNodeId);
    diagramSide.querySelectorAll("[data-goto]").forEach((el) => {
      el.onclick = () => {
        const id = el.getAttribute("data-goto");
        if (model.nodes.some((n) => n.id === id)) { selNodeId = id; renderDiagram(); }
        else openDiff(id);
      };
    });
  }

  function openDiff(path) {
    if (viewMode === "diagram") setViewMode("diff");
    openFile(path);
    const item = filesList.querySelector(`[data-file="${CSS.escape(path)}"]`);
    if (item) markActive(item);
  }

  // ── Diff ⇄ Diagram toggle ────────────────────────────────────────────────
  function setGranButtons() {
    $("#diagram-gran-files")?.classList.toggle("active", gran === "files");
    $("#diagram-gran-modules")?.classList.toggle("active", gran === "modules");
  }
  function setViewMode(mode) {
    viewMode = mode === "diagram" ? "diagram" : "diff";
    const diag = viewMode === "diagram";
    const pane = $("#files-diagram");
    if (pane) pane.style.display = diag ? "flex" : "none";
    if (diffPane) diffPane.style.display = diag ? "none" : "";
    if (btnDiagram) {
      btnDiagram.classList.toggle("active", diag);
      btnDiagram.textContent = diag ? "⇄ diff" : "▦ diagram";
    }
    if (diag) { setGranButtons(); ensureGraph(); }
  }

  // ── Diagram interactions ─────────────────────────────────────────────────
  function svgPoint(evt) {
    // Map through the SVG's own screen matrix so viewBox scaling / letter-boxing
    // is accounted for — plain rect math drifts once the viewBox aspect differs
    // from the element's, which made block dragging feel broken.
    let vx, vy;
    const ctm = diagramSvg.getScreenCTM && diagramSvg.getScreenCTM();
    if (ctm) {
      const pt = diagramSvg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const loc = pt.matrixTransform(ctm.inverse());
      vx = loc.x; vy = loc.y;
    } else {
      const rect = diagramSvg.getBoundingClientRect();
      vx = (evt.clientX - rect.left) * (LAY.w / (rect.width || LAY.w));
      vy = (evt.clientY - rect.top) * (LAY.h / (rect.height || LAY.h));
    }
    return { x: (vx - LAY.tx) / LAY.scale, y: (vy - LAY.ty) / LAY.scale, sx: vx, sy: vy };
  }

  // SVG-safe ancestor walk (Element.closest exists on SVG in modern engines, but
  // this is bulletproof and cheap).
  function closestNode(target) {
    let el = target;
    while (el && el !== diagramSvg) {
      if (el.getAttribute && el.getAttribute("data-node")) return el;
      el = el.parentNode;
    }
    return null;
  }

  let dragNode = null;
  let panFrom = null;
  let dragMoved = false;   // any pointer movement since mousedown (suppresses click)
  let nodeMoved = false;   // a node was actually dragged (needs edge redraw on release)

  if (diagramSvg) {
    diagramSvg.addEventListener("mousedown", (e) => {
      const target = closestNode(e.target);
      dragMoved = false;
      nodeMoved = false;
      if (target) dragNode = LAY.nodes.find((n) => n.id === target.getAttribute("data-node")) || null;
      else panFrom = { x: e.clientX - LAY.tx, y: e.clientY - LAY.ty };
      if (dragNode) diagramSvg.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (dragNode) {
        const p = svgPoint(e);
        dragNode.x = p.x; dragNode.y = p.y;
        dragMoved = true;
        nodeMoved = true;
        const g = closestNodeByAttr(dragNode.id);
        if (g) g.setAttribute("transform", `translate(${dragNode.x.toFixed(1)},${dragNode.y.toFixed(1)})`);
        // Re-route the connectors touching this block so edges follow the drag.
        if (LAY.byId) {
          diagramSvg.querySelectorAll("path.dedge").forEach((path) => {
            const from = path.getAttribute("data-from");
            const to = path.getAttribute("data-to");
            if (from !== dragNode.id && to !== dragNode.id) return;
            const a = LAY.byId.get(from), b = LAY.byId.get(to);
            if (a && b) path.setAttribute("d", orthoPath(a, b));
          });
        }
      } else if (panFrom) {
        LAY.tx = e.clientX - panFrom.x; LAY.ty = e.clientY - panFrom.y;
        dragMoved = true;
        applyTransform();
      }
    });
    function closestNodeByAttr(id) {
      const all = diagramSvg.querySelectorAll("[data-node]");
      for (const g of all) if (g.getAttribute("data-node") === id) return g;
      return null;
    }
    window.addEventListener("mouseup", () => {
      // A real drag leaves stale edges behind, so redraw; a plain click must NOT
      // re-render here or it would remove the node before the click event fires.
      if (nodeMoved) renderDiagram();
      dragNode = null;
      panFrom = null;
      diagramSvg.style.cursor = "";
    });
    diagramSvg.addEventListener("click", (e) => {
      if (dragMoved) return;
      const target = closestNode(e.target);
      selNodeId = target ? target.getAttribute("data-node") : null;
      renderDiagram();
    });
  }
  if (diagramCanvas) {
    diagramCanvas.addEventListener("wheel", (e) => {
      if (!graph) return;
      e.preventDefault();
      const p = svgPoint(e);
      const ns = Math.max(0.15, Math.min(4, LAY.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      LAY.tx = p.sx - p.x * ns;
      LAY.ty = p.sy - p.y * ns;
      LAY.scale = ns;
      applyTransform();
    }, { passive: false });
  }

  // ── Diagram controls ─────────────────────────────────────────────────────
  if (btnDiagram) btnDiagram.onclick = () => setViewMode(viewMode === "diagram" ? "diff" : "diagram");
  $("#diagram-gran-files")?.addEventListener("click", () => { gran = "files"; selNodeId = null; setGranButtons(); renderDiagram(true); });
  $("#diagram-gran-modules")?.addEventListener("click", () => { gran = "modules"; selNodeId = null; setGranButtons(); renderDiagram(true); });
  $("#diagram-relayout")?.addEventListener("click", () => { for (const n of LAY.nodes) { n.x = undefined; n.y = undefined; } renderDiagram(true); });
  $("#diagram-fit")?.addEventListener("click", () => { fitView(); applyTransform(); });
  if (diagramSearchIn) {
    // The layout is O(n²), so debounce keystrokes instead of re-laying out per key.
    let searchTimer = null;
    diagramSearchIn.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { diagramFilter = diagramSearchIn.value; renderDiagram(true); }, 150);
    });
  }
  if (diagramChangedEl) diagramChangedEl.addEventListener("change", () => { diagramChangedOnly = diagramChangedEl.checked; renderDiagram(true); });
  if (diagramImpactEl) diagramImpactEl.addEventListener("change", () => { diagramImpact = diagramImpactEl.checked; renderDiagram(); });

  // Defaults for the Review page: diagram view, file list collapsed, and
  // `.gitignore`d files hidden.
  setFilesHidden(true);
  updateIgnoredButton();
  setViewMode("diagram");

  window.__filesOnView = function () {
    refreshCwd();
    loadModified();
    if (viewMode === "diagram") ensureGraph(true);
  };
  window.__filesOnSessions = function () {
    refreshCwd();
    const cwd = selectedCwd();
    if (cwd && cwd !== current.cwd) {
      loadModified();
      graph = null; graphCwd = "";
      if (viewMode === "diagram") ensureGraph(true);
    }
  };
})();
