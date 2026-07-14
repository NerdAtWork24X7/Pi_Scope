/**
 * files.js — Files view: list git-modified files for a session's cwd and show a
 * Beyond-Compare-style side-by-side diff (git HEAD vs working tree) with per-line
 * copy arrows (← / →) and dual editable panes. Self-contained IIFE.
 */
(function () {
  const S = window.__SCOPE_STATE;
  const $ = (s) => document.querySelector(s);

  const cwdLabel = $("#files-cwd-label");
  const filesList = $("#files-list");
  const filesStatus = $("#files-status");
  const diffOld = $("#diff-old-lines");
  const diffNew = $("#diff-new-lines");
  const diffOldCol = $(".diff-col-old");
  const diffNewCol = $(".diff-col-new");
  const diffFilename = $("#diff-filename");
  const diffStats = $("#diff-stats");
  const showIgnored = $("#files-ignored");
  const btnSave = $("#btn-diff-save");
  const btnCancel = $("#btn-diff-cancel");
  const btnRefresh = $("#btn-files-refresh");
  const btnHide = $("#btn-files-hide");
  const btnMode = $("#btn-diff-mode");
  const btnWrap = $("#btn-diff-wrap");
  const diffGrid = $(".diff-grid");
  const diffResizer = $("#diff-resizer");

  const LINE_CAP = 6000; // combined line count for highlighted diff; above this render plain
  const MAX_CELLS = 9_000_000; // m*n bound for the LCS table
  const STATUS_LABEL = { modified: "M", added: "A", deleted: "D", untracked: "?", renamed: "R", ignored: "I" };

  let current = { cwd: "", file: "", oldBuf: [], newBuf: [], binary: false, dirty: false, baseOldBuf: [], baseNewBuf: [] };
  let activeSide = "new";
  let fullView = true;

  function selectedCwd() {
    return S.cwd || "";
  }

  function refreshCwd() {
    if (cwdLabel) cwdLabel.textContent = S.cwd ? S.cwd : "no directory set — choose one in the Terminal pane";
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
    const ignored = showIgnored && showIgnored.checked ? 1 : 0;
    try {
      const res = await fetch(window.apiUrl("/files/modified", { cwd, token: S.token, ignored }), { headers: window.authHeaders() });
      const data = await res.json();
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
      const rank = (f) => (f.status === "ignored" ? 3 : f.status === "untracked" ? 2 : 1);
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
        caret.textContent = "▾";
        const nm = document.createElement("span");
        nm.className = "tree-name";
        nm.textContent = k + "/";
        dirRow.appendChild(caret);
        dirRow.appendChild(nm);
        const childWrap = document.createElement("div");
        childWrap.className = "tree-children";
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
      const res = await fetch(window.apiUrl("/files/diff", { cwd, file, token: S.token }), { headers: window.authHeaders() });
      const data = await res.json();
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

  // LCS table diff (bounded) with fallback to a plain side-by-side when too large.
  function diffLines(oldL, newL) {
    const m = oldL.length, n = newL.length;
    if (m + n > LINE_CAP || (m > 0 && n > 0 && m * n > MAX_CELLS)) {
      const rows = [];
      const max = Math.max(m, n);
      for (let i = 0; i < max; i++) {
        const oi = i < m ? i : null;
        const nj = i < n ? i : null;
        rows.push({ type: "plain", old: oi != null ? oldL[oi] : null, new: nj != null ? newL[nj] : null, oldNo: oi != null ? i + 1 : null, newNo: nj != null ? i + 1 : null, oldIdx: oi, newIdx: nj, oldIns: i, newIns: i });
      }
      return { plain: true, rows };
    }
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = oldL[i] === newL[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (oldL[i] === newL[j]) { ops.push(["eq", i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["del", i, null]); i++; }
      else { ops.push(["add", null, j]); j++; }
    }
    while (i < m) { ops.push(["del", i, null]); i++; }
    while (j < n) { ops.push(["add", null, j]); j++; }

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
    return { plain: false, rows };
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
      const res = await fetch(window.apiUrl("/files/save", { token: S.token }), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd, file: current.file, content }),
      });
      const data = await res.json();
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
  btnRefresh.onclick = loadModified;
  if (showIgnored) showIgnored.onchange = loadModified;

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

  if (btnHide) btnHide.onclick = () => {
    const hidden = filesList.classList.toggle("hidden");
    btnHide.textContent = hidden ? "☰ show files" : "☰ files";
  };

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

  window.__filesOnView = function () { refreshCwd(); loadModified(); };
  window.__filesOnSessions = function () {
    refreshCwd();
    const cwd = selectedCwd();
    if (cwd && cwd !== current.cwd) loadModified();
  };
})();
