/**
 * git.js — Git view: a Fork-style working-tree git client for the shared cwd.
 * Checkbox stage/unstage, unified diffs with a pinned header, a bottom commit
 * bar, history with a lane graph, branches, remotes, push/pull/fetch, stash.
 * Talks to the /git/* API. Self-contained IIFE.
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => window.SCOPE.escapeHtml(String(s ?? ""));
  const fmtRel = (ts) => window.SCOPE.fmtRel(ts);

  const cwdLabel = $("#git-cwd-label");
  const branchChip = $("#git-branch-chip");
  const syncEl = $("#git-sync");
  const statusEl = $("#git-status");
  const commitMsg = $("#git-commit-msg");
  const amendCB = $("#git-amend");
  const btnCommit = $("#btn-git-commit");
  const btnStageAll = $("#btn-git-stage-all");
  const btnUnstageAll = $("#btn-git-unstage-all");
  const btnFetch = $("#btn-git-fetch");
  const btnPull = $("#btn-git-pull");
  const btnPush = $("#btn-git-push");
  const btnRefresh = $("#btn-git-refresh");
  const diffHeader = $("#git-diff-header");
  const diffBody = $("#git-diff-body");

  const secs = {
    unstaged: $("#git-sec-unstaged .git-sec-list"),
    staged: $("#git-sec-staged .git-sec-list"),
    conflicted: $("#git-sec-conflicted .git-sec-list"),
  };
  const countEls = {
    unstaged: $("#git-sec-unstaged .git-count"),
    staged: $("#git-sec-staged .git-count"),
    conflicted: $("#git-sec-conflicted .git-count"),
  };
  const panes = {
    changes: $("#git-tab-changes"),
    history: $("#git-tab-history"),
    branches: $("#git-tab-branches"),
    stashes: $("#git-tab-stashes"),
    remotes: $("#git-tab-remotes"),
  };
  const historyList = $("#git-history-list");
  const detailPane = $("#git-detail-pane");
  const detailBody = $("#git-detail-body");

  const STATUS_LETTER = { modified: "M", added: "A", deleted: "D", untracked: "?", renamed: "R", conflicted: "!" };

  let repo = { files: [], branch: null, head: null, detached: false, upstream: null, ahead: 0, behind: 0, remotes: [] };
  let selected = { path: "", cached: false, section: "" };
  let activeTab = "history";
  let lastCwd = "";
  let diffMode = "split"; // "split" | "unified"
  let currentDiff = { text: "", path: "", section: "", cached: false, add: 0, del: 0 };
  let detailMode = "commit"; // "commit" | "changes" | "files"
  let currentDetail = null;
  let menuEl = null;

  const selectedCwd = window.SCOPE.currentCwd;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso || "";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}`;
  }
  function hueFor(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function avatarColor(name) { return `hsl(${hueFor(name || "?")}, 55%, 42%)`; }
  function badgeColor(name) { return GRAPH_PALETTE[hueFor(name) % GRAPH_PALETTE.length]; }
  function issueLinkify(text) { return esc(text).replace(/(#[0-9]+)/g, '<span class="git-issue">$1</span>'); }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.style.color = isError ? "var(--red)" : "";
  }

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  const api = window.SCOPE.api;

  function refreshCwd() {
    window.SCOPE.cwdLabel(cwdLabel);
  }

  // ─── Diff rendering (side-by-side split or unified) ────────────────────
  function diffClass(line) {
    if (line.startsWith("+++") || line.startsWith("---")) return "gd-file";
    if (line.startsWith("@@")) return "gd-hunk";
    if (line.startsWith("+")) return "gd-add";
    if (line.startsWith("-")) return "gd-del";
    if (line.startsWith("\\")) return "gd-meta";
    if (/^(diff |index |new file|deleted file|similarity|rename |copy |old mode|new mode|Binary files)/.test(line)) return "gd-meta";
    return "gd-context";
  }
  function renderDiffLines(text) {
    const frag = document.createDocumentFragment();
    for (const line of String(text || "").split("\n")) {
      const span = document.createElement("span");
      span.className = diffClass(line);
      span.textContent = line + "\n";
      frag.appendChild(span);
    }
    return frag;
  }

  // Parse a unified diff into aligned left/right rows for the split view.
  // Consecutive '-' and '+' runs within a hunk are paired line-by-line so a
  // change shows old text on the left and new text on the right.
  function parseSplit(text) {
    const rows = [];
    let oldNo = 0, newNo = 0;
    let pendDel = [], pendAdd = [];
    const flush = () => {
      const n = Math.max(pendDel.length, pendAdd.length);
      for (let i = 0; i < n; i++) {
        const d = pendDel[i], a = pendAdd[i];
        rows.push({ kind: d && a ? "mod" : d ? "del" : "add", left: d || null, right: a || null });
      }
      pendDel = []; pendAdd = [];
    };
    const meta = /^(diff |index |new file|deleted file|similarity|rename |copy |old mode|new mode|Binary files|\\|\+{3}|\-{3})/;
    for (const line of String(text || "").split("\n")) {
      if (line === "") continue; // trailing newline artifact, not a content line
      if (/^@@/.test(line)) {
        flush();
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (m) { oldNo = +m[1]; newNo = +m[3]; }
        rows.push({ kind: "hunk", text: line });
      } else if (meta.test(line)) {
        flush();
        rows.push({ kind: "meta", text: line });
      } else if (line.startsWith("+")) {
        pendAdd.push({ no: newNo++, text: line.slice(1) });
      } else if (line.startsWith("-")) {
        pendDel.push({ no: oldNo++, text: line.slice(1) });
      } else {
        flush();
        rows.push({ kind: "ctx", left: { no: oldNo++, text: line.slice(1) }, right: { no: newNo++, text: line.slice(1) } });
      }
    }
    flush();
    return rows;
  }

  function renderSplit(text) {
    const frag = document.createDocumentFragment();
    for (const r of parseSplit(text)) {
      const row = document.createElement("div");
      if (r.kind === "hunk" || r.kind === "meta") {
        row.className = "gs-row gs-" + r.kind;
        row.textContent = r.text || " ";
        frag.appendChild(row);
        continue;
      }
      row.className = "gs-row";
      const lno = document.createElement("span");
      lno.className = "gs-no";
      lno.textContent = r.left ? String(r.left.no) : "";
      row.appendChild(lno);
      const l = document.createElement("span");
      l.className = "gs-l" + (r.left ? (r.kind === "del" || r.kind === "mod" ? " gs-del" : "") : " gs-empty");
      l.textContent = r.left ? r.left.text : "";
      row.appendChild(l);
      const rno = document.createElement("span");
      rno.className = "gs-no gs-right";
      rno.textContent = r.right ? String(r.right.no) : "";
      row.appendChild(rno);
      const rt = document.createElement("span");
      rt.className = "gs-r" + (r.right ? (r.kind === "add" || r.kind === "mod" ? " gs-add" : "") : " gs-empty");
      rt.textContent = r.right ? r.right.text : "";
      row.appendChild(rt);
      frag.appendChild(row);
    }
    return frag;
  }

  function renderDiffContent(text) {
    if (diffMode === "split") {
      const wrap = document.createElement("div");
      wrap.className = "git-split";
      wrap.appendChild(renderSplit(text));
      return wrap;
    }
    const pre = document.createElement("pre");
    pre.className = "git-diff";
    pre.appendChild(renderDiffLines(text));
    return pre;
  }

  function modeToggle(redraw) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-sm";
    b.textContent = diffMode === "split" ? "☰ unified" : "⇄ split";
    b.title = "Switch diff layout (side-by-side / unified)";
    b.onclick = () => { diffMode = diffMode === "split" ? "unified" : "split"; redraw(); };
    return b;
  }

  function renderChangesDiff() {
    const d = currentDiff;
    diffHeader.innerHTML = "";
    if (d.path) {
      diffHeader.innerHTML =
        `<span class="gdh-file" title="${esc(d.path)}">${esc(d.path)}</span>` +
        `<span style="color:var(--muted);font-size:11px">${esc(d.section)}${d.cached ? " · staged" : ""}</span>` +
        `<span class="gdh-stat"><span class="a">+${d.add}</span> <span class="d">−${d.del}</span></span>`;
      diffHeader.appendChild(modeToggle(renderChangesDiff));
    }
    diffBody.innerHTML = "";
    if (!d.text || !d.text.trim()) {
      diffBody.innerHTML = '<div class="git-diff-empty">no diff for this file</div>';
      return;
    }
    diffBody.appendChild(renderDiffContent(d.text));
  }

  async function openDiff(path, cached, section) {
    diffHeader.innerHTML = "";
    diffBody.innerHTML = '<div class="empty-state">loading…</div>';
    const cwd = selectedCwd();
    const { res, data } = await api("/git/diff", { cwd, file: path, cached: cached ? 1 : 0 });
    if (!res.ok) { diffBody.innerHTML = `<div class="git-diff-empty">error: ${esc(data.error || res.status)}</div>`; return; }
    const diffText = data.diff || "";
    let add = 0, del = 0;
    for (const line of diffText.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    currentDiff = { text: diffText, path, section, cached, add, del };
    renderChangesDiff();
  }

  function selectFile(path, section) {
    selected = { path, cached: section === "staged", section };
    document.querySelectorAll(".git-file.active").forEach((x) => x.classList.remove("active"));
    const row = document.querySelector(`.git-file[data-path="${CSS.escape(path)}"][data-section="${section}"]`);
    if (row) row.classList.add("active");
    setTab("changes");
    openDiff(path, selected.cached, section);
  }

  // ─── File lists (checkbox stage/unstage, Fork-style) ────────────────────
  function actionBtn(label, fn, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (danger) b.className = "danger";
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }
  function listBtn(label, fn, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-sm";
    b.textContent = label;
    if (danger) b.style.cssText = "color:var(--red);border-color:var(--red)";
    b.onclick = fn;
    return b;
  }

  function buildFileRow(f) {
    const row = document.createElement("div");
    row.className = "git-file";
    row.dataset.path = f.path;
    row.dataset.section = f.section;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = f.section === "staged";
    cb.title = f.section === "staged" ? "Unstage" : "Stage";
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => { if (cb.checked) stage([f.path]); else unstage([f.path]); };
    row.appendChild(cb);
    const st = document.createElement("span");
    st.className = "gf-status " + f.status;
    st.textContent = STATUS_LETTER[f.status] || f.status;
    row.appendChild(st);
    const fp = document.createElement("span");
    fp.className = "gf-path";
    fp.textContent = f.path + (f.renamed_from ? `  (← ${f.renamed_from})` : "");
    fp.title = f.path;
    row.appendChild(fp);
    const actions = document.createElement("span");
    actions.className = "gf-actions";
    if (f.section === "untracked") {
      actions.appendChild(actionBtn("rm", () => discard([f.path], true), true));
    } else if (f.section === "conflicted") {
      actions.appendChild(actionBtn("mark resolved", () => stage([f.path])));
    } else if (f.section === "unstaged") {
      actions.appendChild(actionBtn("discard", () => discard([f.path], false), true));
    }
    row.appendChild(actions);
    row.onclick = () => selectFile(f.path, f.section);
    return row;
  }

  function renderFiles(files) {
    const buckets = { unstaged: [], staged: [], conflicted: [] };
    for (const f of files) {
      const key = f.section === "untracked" ? "unstaged" : f.section;
      (buckets[key] || buckets.unstaged).push(f);
    }
    for (const key of Object.keys(secs)) {
      const list = secs[key];
      if (!list) continue;
      list.innerHTML = "";
      if (countEls[key]) countEls[key].textContent = (buckets[key] || []).length || "";
      for (const f of buckets[key] || []) list.appendChild(buildFileRow(f));
    }
  }

  // ─── Mutating actions ─────────────────────────────────────────────────────
  async function stage(paths, all) {
    const cwd = selectedCwd(); if (!cwd) return;
    setStatus("staging…");
    const { res, data } = await api("/git/stage", {}, all ? { cwd, all: true } : { cwd, paths });
    if (!res.ok || !data.ok) { setStatus("stage failed: " + (data.error || res.status), true); return; }
    await loadStatus();
  }
  async function unstage(paths) {
    const cwd = selectedCwd(); if (!cwd || !paths.length) return;
    setStatus("unstaging…");
    const { res, data } = await api("/git/unstage", {}, { cwd, paths });
    if (!res.ok || !data.ok) { setStatus("unstage failed: " + (data.error || res.status), true); return; }
    await loadStatus();
  }
  async function discard(paths, untracked) {
    const cwd = selectedCwd(); if (!cwd) return;
    const msg = untracked
      ? `Delete ${paths.length} untracked file(s)?\n\n${paths.join("\n")}\n\nThis permanently deletes them.`
      : `Discard changes to ${paths.length} file(s)?\n\n${paths.join("\n")}\n\nThey will revert to the last commit. Cannot be undone.`;
    if (!confirm(msg)) return;
    setStatus("discarding…");
    const { res, data } = await api("/git/discard", {}, { cwd, paths, untracked });
    if (!res.ok || !data.ok) { setStatus("discard failed: " + (data.error || res.status), true); return; }
    selected = { path: "", cached: false, section: "" };
    await loadStatus();
  }
  async function commit() {
    const cwd = selectedCwd(); if (!cwd) return;
    const message = commitMsg.value.trim();
    if (!message) { setStatus("enter a commit message", true); commitMsg.focus(); return; }
    const amend = amendCB && amendCB.checked;
    setStatus("committing…");
    const { res, data } = await api("/git/commit", {}, { cwd, message, amend });
    if (!res.ok || !data.ok) { setStatus("commit failed: " + (data.error || res.status), true); return; }
    commitMsg.value = "";
    if (amendCB) amendCB.checked = false;
    setStatus("committed " + (data.sha || ""));
    await loadStatus();
    if (activeTab === "history") loadHistory();
  }
  async function remoteOp(kind) {
    const cwd = selectedCwd(); if (!cwd) return;
    if (kind === "push") {
      const ok = await showGitModal({ title: "Push", message: "Push current branch to upstream?", confirmLabel: "Push" });
      if (!ok) return;
    }
    setStatus(kind + "…");
    const { res, data } = await api("/git/" + kind, {}, { cwd });
    if (!res.ok || !data.ok) { setStatus(kind + " failed: " + (data.error || res.status), true); return; }
    setStatus(kind + " ok" + (data.out ? " — " + data.out.split("\n")[0].slice(0, 120) : ""));
    await loadStatus();
  }
  async function branchOp(action, name) {
    const cwd = selectedCwd(); if (!cwd) return;
    if (action === "delete" && !confirm(`Delete branch '${name}'?`)) return;
    setStatus(action + " branch " + name + "…");
    const { res, data } = await api("/git/branch", {}, { cwd, action, name });
    if (!res.ok || !data.ok) { setStatus("branch " + action + " failed: " + (data.error || res.status), true); return; }
    setStatus("branch " + action + " ok");
    await loadStatus();
    loadBranches();
  }
  async function remoteOp2(action, name, url) {
    const cwd = selectedCwd(); if (!cwd) return;
    if (action === "remove" && !confirm(`Remove remote '${name}'?`)) return;
    setStatus("remote " + action + "…");
    const { res, data } = await api("/git/remote", {}, { cwd, action, name, url });
    if (!res.ok || !data.ok) { setStatus("remote " + action + " failed: " + (data.error || res.status), true); return; }
    setStatus("remote " + action + " ok");
    await loadStatus();
    loadRemotes();
  }
  async function stashOp(action, ref, message) {
    const cwd = selectedCwd(); if (!cwd) return;
    if (action === "drop" && !confirm(`Drop stash ${ref}?`)) return;
    setStatus("stash " + action + "…");
    const { res, data } = await api("/git/stash", {}, { cwd, action, ref, message });
    if (!res.ok || !data.ok) { setStatus("stash " + action + " failed: " + (data.error || res.status), true); return; }
    setStatus("stash " + action + " ok");
    await loadStatus();
    loadStashes();
  }

  // ─── History lane graph (coloured, vscode-git-graph style) ──────────────
  // The server returns commits in --topo-order with parent SHAs. We assign
  // each commit a lane (column) and draw vertical rails, smooth merge curves
  // and commit nodes as an inline SVG per row.
  const LANE_W = 16;
  const ROW_H = 48;
  const NODE_R = 5;
  const GRAPH_PALETTE = ["#4c9aff", "#56d364", "#f0883e", "#db61a2", "#a371f7", "#39c5cf", "#e3b341", "#f85149"];

  function laneX(i) { return i * LANE_W + LANE_W / 2; }

  function buildGraph(commits) {
    const colors = [];
    const lanes = []; // tip SHA per lane (null = free)
    const commitLane = new Map();
    let pi = 0;
    const grow = (i) => { while (colors.length <= i) { colors.push(GRAPH_PALETTE[pi++ % GRAPH_PALETTE.length]); lanes.push(null); } };
    const freeLane = (exclude) => { for (let j = 0; j < lanes.length; j++) if (lanes[j] === null && !exclude.has(j)) return j; return -1; };

    const rows = [];
    for (const c of commits) {
      let self = commitLane.get(c.sha);
      if (self === undefined) {
        self = freeLane(new Set());
        if (self === -1) self = lanes.length;
        commitLane.set(c.sha, self);
      }
      grow(self);
      const lanesBefore = lanes.slice();
      const taken = new Set([self]);
      const parentLanes = [];
      const parents = c.parents || [];
      for (let i = 0; i < parents.length; i++) {
        const p = parents[i];
        let pl = commitLane.get(p);
        if (pl === undefined) {
          pl = i === 0 ? self : freeLane(taken);
          if (pl === -1) pl = lanes.length;
          commitLane.set(p, pl);
        }
        taken.add(pl);
        parentLanes.push(pl);
        grow(pl);
      }
      const lanesAfter = lanes.slice();
      for (let i = 0; i < lanesAfter.length; i++) if (lanesAfter[i] === c.sha) lanesAfter[i] = null;
      parents.forEach((p, i) => { lanesAfter[parentLanes[i]] = p; });
      while (lanesAfter.length < colors.length) lanesAfter.push(null);
      rows.push({ c, self, parentLanes, lanesBefore, lanesAfter });
      for (let i = 0; i < colors.length; i++) lanes[i] = lanesAfter[i] ?? null;
    }
    return { rows, colors };
  }

  function rowSVG(row, colors) {
    const { self, parentLanes, lanesBefore } = row;
    const W = colors.length * LANE_W;
    const parts = [];
    for (let i = 0; i < lanesBefore.length; i++) {
      if (lanesBefore[i] === null || i === self) continue;
      parts.push(`<line x1="${laneX(i)}" y1="0" x2="${laneX(i)}" y2="${ROW_H}" stroke="${colors[i]}" stroke-width="2"/>`);
    }
    if (lanesBefore[self] != null) {
      parts.push(`<line x1="${laneX(self)}" y1="0" x2="${laneX(self)}" y2="${ROW_H / 2}" stroke="${colors[self]}" stroke-width="2"/>`);
    }
    parts.push(`<circle cx="${laneX(self)}" cy="${ROW_H / 2}" r="${NODE_R}" fill="${colors[self]}"/>`);
    for (const pl of parentLanes) {
      if (pl === self) {
        parts.push(`<line x1="${laneX(self)}" y1="${ROW_H / 2}" x2="${laneX(self)}" y2="${ROW_H}" stroke="${colors[self]}" stroke-width="2"/>`);
      } else {
        const x0 = laneX(self), x1 = laneX(pl), y0 = ROW_H / 2;
        parts.push(`<path d="M ${x0} ${y0} C ${x0} ${y0 + ROW_H * 0.6}, ${x1} ${y0 + ROW_H * 0.4}, ${x1} ${ROW_H}" stroke="${colors[pl]}" stroke-width="2" fill="none"/>`);
      }
    }
    return `<svg width="${W}" height="${ROW_H}" viewBox="0 0 ${W} ${ROW_H}" shape-rendering="geometricPrecision">${parts.join("")}</svg>`;
  }

  function refBadges(refs) {
    if (!refs) return "";
    return refs.split(",").map((s) => s.trim()).filter(Boolean).map((p) => {
      const isHead = p.startsWith("HEAD ->");
      const name = isHead ? p.slice("HEAD ->".length) : p;
      const c = badgeColor(name);
      const check = isHead ? '<span class="git-ref-check">✓</span>' : "";
      return `<span class="git-ref-badge" style="background:${c}26;color:${c};border:1px solid ${c}66" title="${esc(p)}">${check}${esc(name)}</span>`;
    }).join("");
  }

  // ─── Tabs ─────────────────────────────────────────────────────────────────
  function setTab(name) {
    activeTab = name;
    document.querySelectorAll(".git-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    for (const k of Object.keys(panes)) if (panes[k]) panes[k].hidden = k !== name;
    if (name === "history") loadHistory();
    else if (name === "branches") loadBranches();
    else if (name === "stashes") loadStashes();
    else if (name === "remotes") loadRemotes();
  }

  function commitRow(row, colors) {
    const c = row.c;
    const root = document.createElement("div");
    root.className = "git-commit-row";
    root.dataset.sha = c.sha;

    const cell = document.createElement("div");
    cell.className = "git-graph-cell";
    cell.innerHTML = rowSVG(row, colors);
    root.appendChild(cell);

    const msg = document.createElement("div");
    msg.className = "git-msg-cell";
    const refs = refBadges(c.refs);
    if (refs) msg.appendChild(el(`<span class="git-msg-refs">${refs}</span>`));
    const subj = el('<span class="git-msg-subject"></span>');
    subj.textContent = c.subject;
    subj.title = c.subject;
    msg.appendChild(subj);
    root.appendChild(msg);

    const author = document.createElement("div");
    author.className = "git-author-cell";
    author.title = c.author;
    const av = el('<span class="git-avatar"></span>');
    av.style.background = avatarColor(c.author);
    av.textContent = (c.author || "?").trim()[0] || "?";
    author.appendChild(av);
    const nm = el('<span class="git-author-name"></span>');
    nm.textContent = c.author;
    author.appendChild(nm);
    root.appendChild(author);

    const hash = el('<span class="git-hash-cell"></span>');
    hash.textContent = c.short;
    root.appendChild(hash);

    const date = el('<span class="git-date-cell"></span>');
    date.textContent = fmtDate(c.date);
    date.title = c.date;
    root.appendChild(date);

    root.onclick = () => {
      document.querySelectorAll(".git-commit-row.active").forEach((x) => x.classList.remove("active"));
      root.classList.add("active");
      showCommitDetail(c.sha);
    };
    root.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showCommitMenu(c.sha, e.clientX, e.clientY); };
    return root;
  }

  async function loadHistory() {
    historyList.innerHTML = '<div class="empty-state">loading…</div>';
    const cwd = selectedCwd();
    if (!cwd) { historyList.innerHTML = '<div class="empty-state">no directory set</div>'; return; }
    const { res, data } = await api("/git/log", { cwd, limit: 200, all: 1 });
    if (!res.ok || !data.ok) { historyList.innerHTML = `<div class="git-diff-empty">error: ${esc(data.error || res.status)}</div>`; return; }
    const commits = data.commits || data.entries || [];
    if (!commits.length) { historyList.innerHTML = '<div class="empty-state">no commits yet</div>'; return; }
    const graph = buildGraph(commits);
    historyList.innerHTML = "";
    for (const row of graph.rows) historyList.appendChild(commitRow(row, graph.colors));
  }

  function setDetailTab(mode) {
    detailMode = mode;
    document.querySelectorAll(".git-detail-tab").forEach((t) => t.classList.toggle("active", t.dataset.dtab === mode));
    if (currentDetail) renderDetail(mode, currentDetail);
  }

  async function showCommitDetail(sha) {
    detailPane.hidden = false;
    detailBody.innerHTML = '<div class="empty-state">loading…</div>';
    const cwd = selectedCwd();
    const { res, data } = await api("/git/show", { cwd, sha });
    if (!res.ok) { detailBody.innerHTML = `<div class="git-diff-empty">error: ${esc(data.error || res.status)}</div>`; return; }
    currentDetail = data;
    setDetailTab(detailMode);
  }

  function renderDetail(mode, data) {
    detailBody.innerHTML = "";
    if (mode === "changes") {
      const wrap = document.createElement("div");
      const render = () => {
        wrap.innerHTML = "";
        const bar = document.createElement("div");
        bar.className = "git-diff-mode";
        bar.appendChild(modeToggle(render));
        wrap.appendChild(bar);
        wrap.appendChild(renderDiffContent(data.diff || ""));
      };
      render();
      detailBody.appendChild(wrap);
    } else if (mode === "files") {
      detailBody.appendChild(renderFileTree(data.files || []));
    } else {
      detailBody.appendChild(renderCommitInfo(data));
    }
  }

  function personRow(label, name, email, date) {
    return (
      `<div class="git-detail-person">` +
      `<div class="git-detail-person-avatar" style="background:${avatarColor(name)}">${esc((name || "?")[0])}</div>` +
      `<div class="git-detail-person-meta">` +
      `<div class="git-detail-label">${esc(label)}</div>` +
      `<div class="git-detail-name">${esc(name)}</div>` +
      (email ? `<div class="git-detail-sub">${esc(email)}</div>` : "") +
      (date ? `<div class="git-detail-sub">${esc(date)}</div>` : "") +
      `</div></div>`
    );
  }

  function renderCommitInfo(data) {
    const wrap = document.createElement("div");
    const parents = data.parents || [];
    wrap.innerHTML =
      personRow("Author", data.author, data.email, data.date) +
      personRow("Committer", data.committer, data.committerEmail, data.committerDate) +
      `<div class="git-detail-row"><span class="git-detail-label">SHA</span><span class="git-detail-hash">${esc(data.sha)}</span></div>` +
      (parents.length
        ? `<div class="git-detail-row"><span class="git-detail-label">Parents</span>` + parents.map((p) => `<span class="git-detail-hash">${esc(p.slice(0, 8))}</span>`).join(" ") + `</div>`
        : "") +
      `<div class="git-detail-msg">` +
      `<div class="git-detail-title">${issueLinkify(data.subject || "")}</div>` +
      (data.body ? `<div class="git-detail-msg-body">${issueLinkify(data.body)}</div>` : "") +
      `</div>` +
      `<div class="git-detail-label" style="margin-bottom:4px">Files changed</div>` +
      (data.files && data.files.length
        ? data.files.map((f) => `<div class="git-detail-file"><span class="git-file-icon">📄</span><span>${esc(f)}</span></div>`).join("")
        : `<div class="git-diff-empty">no files</div>`);
    return wrap;
  }

  function renderFileTree(files) {
    const wrap = document.createElement("div");
    if (!files.length) { wrap.innerHTML = '<div class="git-diff-empty">no files</div>'; return wrap; }
    wrap.innerHTML = files.map((f) => `<div class="git-detail-file"><span class="git-file-icon">📄</span><span>${esc(f)}</span></div>`).join("");
    return wrap;
  }

  // ─── Modal dialog (replaces browser prompt/confirm for Electron compat) ──
  function showGitModal({ title, message, input, confirmLabel, danger }) {
    return new Promise((resolve) => {
      closeMenu();
      const backdrop = document.createElement("div");
      backdrop.className = "git-modal-backdrop";
      const box = document.createElement("div");
      box.className = "git-modal-box";

      const hdr = document.createElement("div");
      hdr.className = "git-modal-title";
      hdr.textContent = title;
      box.appendChild(hdr);

      if (message) {
        const m = document.createElement("div");
        m.className = "git-modal-msg";
        m.textContent = message;
        box.appendChild(m);
      }

      let inputEl = null;
      if (input) {
        inputEl = document.createElement("input");
        inputEl.className = "git-modal-input";
        inputEl.placeholder = input.placeholder || "";
        inputEl.value = input.value || "";
        box.appendChild(inputEl);
        setTimeout(() => inputEl.focus(), 60);
      }

      const actions = document.createElement("div");
      actions.className = "git-modal-actions";
      const cancel = document.createElement("button");
      cancel.className = "git-modal-btn";
      cancel.textContent = "Cancel";
      cancel.onclick = () => { backdrop.remove(); resolve(input ? null : false); };
      const ok = document.createElement("button");
      ok.className = "git-modal-btn" + (danger ? " danger" : " primary");
      ok.textContent = confirmLabel || "OK";
      ok.onclick = () => { const v = inputEl ? inputEl.value : true; backdrop.remove(); resolve(v); };
      actions.appendChild(cancel);
      actions.appendChild(ok);

      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ok.click();
        if (e.key === "Escape") cancel.click();
      });
      box.appendChild(actions);
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      // Ensure keyboard input works without clicking first
      box.tabIndex = -1;
      box.focus();
      if (!inputEl) ok.focus(); // auto-focus OK on confirm-only dialogs

      backdrop.addEventListener("mousedown", (e) => {
        if (e.target === backdrop) cancel.click();
      });
    });
  }

  // ─── Commit context menu (right-click) ───────────────────────────────────
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

  function showCommitMenu(sha, x, y) {
    closeMenu();
    menuEl = document.createElement("div");
    menuEl.className = "git-menu";
    const add = (label, fn, danger) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "git-menu-item" + (danger ? " danger" : "");
      b.textContent = label;
      b.onclick = () => { closeMenu(); fn(); };
      menuEl.appendChild(b);
    };
    const sep = () => { const d = document.createElement("div"); d.className = "git-menu-sep"; menuEl.appendChild(d); };

    add("Checkout this commit", async () => {
      const ok = await showGitModal({ title: "Checkout Commit", message: "Checkout this commit as a detached HEAD?", confirmLabel: "Checkout" });
      if (ok) gitAction("checkout", sha);
    });
    add("Checkout branch…", async () => {
      const n = await showGitModal({ title: "Checkout Branch", input: { placeholder: "Branch name to check out…" }, confirmLabel: "Checkout" });
      if (n && n.trim()) branchOp("switch", n.trim());
    });
    add("Create branch…", async () => {
      const n = await showGitModal({ title: "Create Branch", input: { placeholder: "New branch name…" }, confirmLabel: "Create" });
      if (n && n.trim()) gitAction("branch", sha, n.trim());
    });
    add("Create tag here…", async () => {
      const n = await showGitModal({ title: "Create Tag", input: { placeholder: "New tag name…" }, confirmLabel: "Create" });
      if (n && n.trim()) gitAction("tag", sha, n.trim());
    });
    add("Cherry-pick this commit", async () => {
      const ok = await showGitModal({ title: "Cherry-pick", message: "Cherry-pick this commit?", confirmLabel: "Cherry-pick" });
      if (ok) gitAction("cherry-pick", sha);
    });
    add("Revert this commit", async () => {
      const ok = await showGitModal({ title: "Revert", message: "Revert this commit (creates a revert commit)?", confirmLabel: "Revert" });
      if (ok) gitAction("revert", sha);
    });
    add("Rebase current branch onto this commit", async () => {
      const ok = await showGitModal({ title: "Rebase", message: "Rebase the current branch onto this commit?", confirmLabel: "Rebase", danger: true });
      if (ok) gitAction("rebase", sha);
    }, true);
    sep();
    add("Reset current branch to here (mixed)", async () => {
      const ok = await showGitModal({ title: "Reset", message: "Reset the current branch to this commit (--mixed)? Uncommitted changes stay in the working tree.", confirmLabel: "Reset", danger: true });
      if (ok) gitAction("reset", sha);
    }, true);
    sep();
    add("Copy full hash", () => { navigator.clipboard.writeText(sha).catch(() => {}); setStatus("copied " + sha.slice(0, 8)); });

    document.body.appendChild(menuEl);
    const rect = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
    menuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
  }

  async function gitAction(action, sha, name) {
    const cwd = selectedCwd(); if (!cwd) return;
    setStatus(action + "…");
    const { res, data } = await api("/git/action", {}, { cwd, action, sha, name });
    if (!res.ok || !data.ok) {
      if (data.conflict) {
        // A conflict (rebase/cherry-pick) leaves the repo mid-operation; refresh
        // the Changes list to surface conflicted files, then keep the message.
        await loadStatus();
        setStatus(action + " conflict — resolve it in the terminal: " + (data.error || res.status), true);
      } else {
        setStatus(action + " failed: " + (data.error || res.status), true);
      }
      return;
    }
    setStatus(action + " ok");
    await loadStatus();
  }

  async function loadBranches() {
    panes.branches.innerHTML = '<div class="empty-state">loading…</div>';
    const cwd = selectedCwd();
    if (!cwd) { panes.branches.innerHTML = '<div class="empty-state">no directory set</div>'; return; }
    const { res, data } = await api("/git/branches", { cwd });
    if (!res.ok) { panes.branches.innerHTML = `<div class="git-diff-empty">error: ${esc(data.error || res.status)}</div>`; return; }
    const branches = data.branches || [];
    panes.branches.innerHTML = "";
    const form = el('<div class="git-new-branch"></div>');
    const inp = document.createElement("input");
    inp.placeholder = "new branch name…";
    const create = listBtn("＋ create & switch", async () => { const n = inp.value.trim(); if (n) await branchOp("create", n); });
    form.appendChild(inp);
    form.appendChild(create);
    panes.branches.appendChild(form);
    if (!branches.length) panes.branches.appendChild(el('<div class="git-diff-empty">no branches</div>'));
    for (const br of branches) {
      const row = el('<div class="git-branch-item"></div>');
      if (br.name === data.current) row.classList.add("current");
      const nm = el('<span class="gb-name"></span>');
      nm.textContent = br.name;
      nm.title = br.name;
      const meta = el('<span class="gb-meta"></span>');
      meta.textContent = `${br.sha}${br.upstream ? " → " + br.upstream : ""} · ${br.date}`;
      row.appendChild(nm);
      row.appendChild(meta);
      row.appendChild(listBtn(br.name === data.current ? "✓" : "switch", () => branchOp("switch", br.name)));
      row.appendChild(listBtn("del", () => branchOp("delete", br.name), true));
      panes.branches.appendChild(row);
    }
  }

  async function loadRemotes() {
    panes.remotes.innerHTML = '<div class="empty-state">loading…</div>';
    const cwd = selectedCwd();
    if (!cwd) { panes.remotes.innerHTML = '<div class="empty-state">no directory set</div>'; return; }
    const { res, data } = await api("/git/remotes", { cwd });
    if (!res.ok) { panes.remotes.innerHTML = `<div class="git-diff-empty">error: ${esc(data.error || res.status)}</div>`; return; }
    const remotes = data.remotes || [];
    panes.remotes.innerHTML = "";
    const form = el('<div class="git-remote-form"></div>');
    const nameInp = document.createElement("input");
    nameInp.placeholder = "name (origin)";
    const urlInp = document.createElement("input");
    urlInp.placeholder = "url (git@github.com:…)";
    urlInp.style.flex = "1";
    const addBtn = listBtn("＋ add", async () => { const n = nameInp.value.trim(); const u = urlInp.value.trim(); if (n && u) await remoteOp2("add", n, u); });
    form.appendChild(nameInp);
    form.appendChild(urlInp);
    form.appendChild(addBtn);
    panes.remotes.appendChild(form);
    if (!remotes.length) panes.remotes.appendChild(el('<div class="git-diff-empty">no remotes configured</div>'));
    for (const r of remotes) {
      const row = el('<div class="git-remote-item"><span class="gr-name"></span><span class="gr-url"></span></div>');
      row.querySelector(".gr-name").textContent = r.name;
      const u = r.fetch || r.push;
      row.querySelector(".gr-url").textContent = u;
      row.querySelector(".gr-url").title = u;
      row.appendChild(listBtn("remove", () => remoteOp2("remove", r.name), true));
      panes.remotes.appendChild(row);
    }
  }

  async function loadStashes() {
    panes.stashes.innerHTML = '<div class="empty-state">loading…</div>';
    const cwd = selectedCwd();
    if (!cwd) { panes.stashes.innerHTML = '<div class="empty-state">no directory set</div>'; return; }
    const { res, data } = await api("/git/stash", { cwd });
    if (!res.ok) { panes.stashes.innerHTML = `<div class="git-diff-empty">error: ${esc(data.error || res.status)}</div>`; return; }
    const items = data.items || [];
    panes.stashes.innerHTML = "";
    const form = el('<div class="git-new-branch"></div>');
    const inp = document.createElement("input");
    inp.placeholder = "stash message…";
    const push = listBtn("＋ stash", async () => { await stashOp("push", "", inp.value.trim()); });
    form.appendChild(inp);
    form.appendChild(push);
    panes.stashes.appendChild(form);
    if (!items.length) panes.stashes.appendChild(el('<div class="git-diff-empty">no stashes</div>'));
    for (const it of items) {
      const row = el('<div class="git-branch-item"><span class="gb-name"></span><span class="gb-meta"></span></div>');
      row.querySelector(".gb-name").textContent = it.ref;
      row.querySelector(".gb-meta").textContent = `${it.subject} · ${fmtRel(it.date)}`;
      row.appendChild(listBtn("pop", () => stashOp("pop", it.ref)));
      row.appendChild(listBtn("drop", () => stashOp("drop", it.ref), true));
      panes.stashes.appendChild(row);
    }
  }

  // ─── Main status load ─────────────────────────────────────────────────────
  async function loadStatus() {
    const cwd = selectedCwd();
    refreshCwd();
    if (!cwd) {
      branchChip.textContent = "…";
      syncEl.innerHTML = "";
      renderFiles([]);
      diffHeader.innerHTML = "";
      diffBody.innerHTML = '<div class="empty-state"><span class="icon">⛓</span>no working directory set — choose one in the Terminal pane</div>';
      setStatus("");
      return;
    }
    setStatus("scanning…");
    const { res, data } = await api("/git/status", { cwd });
    if (!res.ok) { setStatus(data.error || res.status, true); return; }
    if (!data.git) {
      branchChip.textContent = "not a repo";
      branchChip.classList.add("detached");
      syncEl.innerHTML = "";
      renderFiles([]);
      diffHeader.innerHTML = "";
      diffBody.innerHTML = '<div class="empty-state"><span class="icon">⛓</span>not a git repository</div>';
      setStatus("");
      return;
    }
    repo = data;
    branchChip.textContent = data.detached ? ("detached · " + (data.head || "")) : (data.branch || "detached");
    branchChip.classList.toggle("detached", !!data.detached);
    if (data.upstream) syncEl.innerHTML = `<span class="ahead">↑${data.ahead}</span> <span class="behind">↓${data.behind}</span>`;
    else if (data.detached) syncEl.innerHTML = "";
    else syncEl.textContent = "no upstream";
    renderFiles(data.files || []);
    setStatus("");
    if (activeTab === "history") loadHistory();
    else if (activeTab === "branches") loadBranches();
    else if (activeTab === "stashes") loadStashes();
    else if (activeTab === "remotes") loadRemotes();
    else {
      const files = data.files || [];
      const stillThere = selected.path && files.some((f) => f.path === selected.path && f.section === selected.section);
      if (stillThere) openDiff(selected.path, selected.cached, selected.section);
      else if (files.length) selectFile(files[0].path, files[0].section);
      else {
        diffHeader.innerHTML = "";
        diffBody.innerHTML = '<div class="empty-state"><span class="icon">✓</span>working tree clean</div>';
      }
    }
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  btnRefresh.onclick = loadStatus;
  btnCommit.onclick = commit;
  btnStageAll.onclick = () => stage(null, true);
  btnUnstageAll.onclick = () => {
    const staged = repo.files.filter((f) => f.section === "staged").map((f) => f.path);
    if (staged.length) unstage(staged);
    else setStatus("nothing staged");
  };
  btnPush.onclick = () => remoteOp("push");
  btnPull.onclick = () => remoteOp("pull");
  btnFetch.onclick = () => remoteOp("fetch");
  commitMsg.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(); });
  document.querySelectorAll(".git-tab").forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });
  document.querySelectorAll(".git-detail-tab").forEach((t) => { t.onclick = () => setDetailTab(t.dataset.dtab); });
  document.addEventListener("mousedown", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  window.addEventListener("blur", closeMenu);

  // ─── Resizable working-directory sidebar ────────────────────────────────
  (function initGitSideResizer() {
    const side = document.querySelector(".git-side");
    const resizer = document.getElementById("git-side-resizer");
    if (!side || !resizer) return;

    const MIN = 160, MAX = 640, KEY = "scope-git-side-width";

    function setWidth(w) { side.style.width = Math.round(w) + "px"; }
    try {
      const saved = parseInt(localStorage.getItem(KEY), 10);
      if (saved >= MIN && saved <= MAX) setWidth(saved);
    } catch {}

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side.getBoundingClientRect().width;
      resizer.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMove = (ev) => {
        setWidth(Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX))));
      };
      const onUp = () => {
        resizer.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        try { localStorage.setItem(KEY, Math.round(side.getBoundingClientRect().width)); } catch {}
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  })();

  window.__gitOnView = function () { refreshCwd(); loadStatus(); };
  window.__gitOnSessions = function () {
    refreshCwd();
    const cwd = selectedCwd();
    if (cwd && cwd !== lastCwd) { lastCwd = cwd; loadStatus(); }
  };
})();
