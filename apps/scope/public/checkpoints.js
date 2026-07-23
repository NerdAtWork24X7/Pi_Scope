/**
 * checkpoints.js — Checkpoints view: git-backed working-tree snapshots for a
 * session's cwd. Manual only: "Checkpoint now" commits + creates a
 * refs/checkpoints/<session>/<id> ref; "Restore" runs git reset --hard + clean.
 * Self-contained IIFE.
 */
(function () {
  const S = window.__SCOPE_STATE;
  const $ = (s) => document.querySelector(s);

  const cwdLabel = $("#checkpoints-cwd-label");
  let lastCwd = "";
  const listEl = $("#checkpoints-list");
  const statusEl = $("#checkpoints-status");
  const labelInput = $("#checkpoints-label");
  const btnCreate = $("#btn-checkpoints-create");
  const btnRefresh = $("#btn-checkpoints-refresh");

  function selectedCwd() {
    return S.cwd || "";
  }

  function refreshCwd() {
    if (cwdLabel) cwdLabel.textContent = S.cwd ? S.cwd : "no directory set — choose one in the Terminal pane";
  }

  async function loadCheckpoints() {
    const cwd = selectedCwd();
    listEl.innerHTML = '<div class="empty-state">loading…</div>';
    if (!cwd) { listEl.innerHTML = '<div class="empty-state">no working directory set — choose one in the Terminal pane</div>'; return; }
    try {
      const res = await fetch(window.apiUrl("/checkpoints/list", { cwd, token: S.token }), { headers: window.authHeaders() });
      const data = await res.json();
      if (!data.git) {
        listEl.innerHTML = `<div class="empty-state">git unavailable in<br><code>${window.SCOPE.escapeHtml(cwd)}</code></div>`;
        return;
      }
      const items = data.items || [];
      if (!items.length) {
        listEl.innerHTML = '<div class="empty-state">no checkpoints yet — click “Checkpoint now”</div>';
        return;
      }
      listEl.innerHTML = "";
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "checkpoint-item";
        const msg = document.createElement("span");
        msg.className = "cp-msg";
        msg.textContent = it.message;
        msg.title = it.ref;
        const meta = document.createElement("span");
        meta.className = "cp-meta";
        const t = window.SCOPE.fmtRel(it.ts);
        meta.innerHTML = `<span class="cp-sha">${window.SCOPE.escapeHtml(window.SCOPE.shortId(it.sha))}</span> · ${window.SCOPE.escapeHtml(t)}`;
        const merge = document.createElement("button");
        merge.className = "btn-sm cp-merge";
        merge.textContent = "↘ merge";
        merge.title = "Merge this checkpoint branch into another branch";
        merge.onclick = () => mergeCheckpoint(it.ref);
        const restore = document.createElement("button");
        restore.className = "btn-sm cp-restore";
        restore.textContent = "↺ restore";
        restore.onclick = () => restoreCheckpoint(it.ref);
        const del = document.createElement("button");
        del.className = "btn-sm cp-delete";
        del.textContent = "✕ delete";
        del.onclick = () => deleteCheckpoint(it.ref);
        row.appendChild(msg);
        row.appendChild(meta);
        row.appendChild(merge);
        row.appendChild(restore);
        row.appendChild(del);
        listEl.appendChild(row);
      }
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state">error: ${window.SCOPE.escapeHtml(String(e))}</div>`;
    }
  }

  async function createCheckpoint() {
    const cwd = selectedCwd();
    if (!cwd) { statusEl.textContent = "set a working directory first (Terminal pane)"; return; }
    btnCreate.disabled = true;
    statusEl.textContent = "creating…";
    try {
      const res = await fetch(window.apiUrl("/checkpoints/create", { token: S.token }), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd, label: labelInput.value.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) statusEl.textContent = "failed: " + window.SCOPE.escapeHtml(data.error || res.status);
      else { statusEl.textContent = "created " + window.SCOPE.shortId(data.sha); labelInput.value = ""; loadCheckpoints(); }
    } catch (e) {
      statusEl.textContent = "error: " + window.SCOPE.escapeHtml(String(e));
    } finally {
      btnCreate.disabled = false;
    }
  }

  async function restoreCheckpoint(ref) {
    const cwd = selectedCwd();
    if (!cwd) { statusEl.textContent = "set a working directory first (Terminal pane)"; return; }
    if (!confirm("Restore working tree to this checkpoint?\n\nThis runs `git reset --hard` + `git clean -fd` — DESTRUCTIVE. Uncommitted changes and untracked files will be discarded.")) return;
    statusEl.textContent = "restoring…";
    try {
      const res = await fetch(window.apiUrl("/checkpoints/restore", { token: S.token }), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd, ref }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) statusEl.textContent = "restore failed: " + window.SCOPE.escapeHtml(data.error || res.status);
      else { statusEl.textContent = "restored to " + window.SCOPE.shortId(data.sha); loadCheckpoints(); }
    } catch (e) {
      statusEl.textContent = "error: " + window.SCOPE.escapeHtml(String(e));
    }
  }

  const mergeModal = $("#cp-merge-modal");
  const mergeSelect = $("#cp-merge-branch-select");
  const mergeConfirm = $("#cp-merge-confirm");
  const mergeCancel = $("#cp-merge-cancel");
  const mergeSubtitle = $("#cp-merge-subtitle");
  let pendingMergeRef = "";

  function checkpointBranchName(ref) {
    const parts = ref.split("/");
    const id = parts.pop();
    const ns = parts[parts.length - 1];
    return `checkpoints/${ns}/${id}`;
  }

  function closeMergeModal() {
    mergeModal.style.display = "none";
    pendingMergeRef = "";
    mergeSelect.innerHTML = "";
    if (mergeSubtitle) mergeSubtitle.textContent = "";
  }

  async function openMergeModal(ref) {
    const cwd = selectedCwd();
    if (!cwd) { statusEl.textContent = "set a working directory first (Terminal pane)"; return; }
    pendingMergeRef = ref;
    statusEl.textContent = "loading branches…";
    try {
      const res = await fetch(window.apiUrl("/checkpoints/branches", { cwd, token: S.token }), { headers: window.authHeaders() });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        statusEl.textContent = "failed to load branches: " + window.SCOPE.escapeHtml(data.error || res.status);
        return;
      }
      mergeSelect.innerHTML = "";
      if (mergeSubtitle) mergeSubtitle.textContent = checkpointBranchName(ref);
      const ownBranch = checkpointBranchName(ref);
      const branches = (data.branches || []).filter((b) => b !== ownBranch);
      for (const b of branches) {
        const opt = document.createElement("option");
        opt.value = b;
        opt.textContent = b === data.current ? b + " (current)" : b;
        if (b === data.current) opt.selected = true;
        mergeSelect.appendChild(opt);
      }
      mergeConfirm.disabled = branches.length === 0;
      if (branches.length === 0) {
        const opt = document.createElement("option");
        opt.textContent = "no other branches";
        opt.disabled = true;
        mergeSelect.appendChild(opt);
      }
      mergeModal.style.display = "flex";
      statusEl.textContent = "";
    } catch (e) {
      statusEl.textContent = "error loading branches: " + window.SCOPE.escapeHtml(String(e));
    }
  }

  async function doMerge() {
    const target = (mergeSelect.value || "").trim();
    if (!target || !pendingMergeRef) return;
    const cpBranch = checkpointBranchName(pendingMergeRef);
    if (!confirm(`Merge checkpoint branch ${cpBranch} into '${target}'?\n\nThis runs \`git merge --no-ff\` on the target branch.`)) return;
    const cwd = selectedCwd();
    const ref = pendingMergeRef;
    closeMergeModal();
    statusEl.textContent = "merging…";
    try {
      const res = await fetch(window.apiUrl("/checkpoints/merge", { token: S.token }), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd, ref, target }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        statusEl.textContent = "merge failed: " + window.SCOPE.escapeHtml(data.error || res.status);
        return;
      }
      statusEl.textContent = "merged into " + window.SCOPE.escapeHtml(target);
      loadCheckpoints();
      askDeleteAfterMerge(ref);
    } catch (e) {
      statusEl.textContent = "error: " + window.SCOPE.escapeHtml(String(e));
    }
  }

  function askDeleteAfterMerge(ref) {
    const branchName = checkpointBranchName(ref);
    if (!confirm(`Delete the checkpoint branch ${branchName}?\n\nIt is no longer needed after the merge. Click OK to remove it, or Cancel to keep it.`)) return;
    deleteCheckpoint(ref, true);
  }

  mergeCancel.onclick = closeMergeModal;
  mergeConfirm.onclick = doMerge;
  mergeModal.onclick = (e) => { if (e.target === mergeModal) closeMergeModal(); };

  async function mergeCheckpoint(ref) {
    await openMergeModal(ref);
  }

  async function deleteCheckpoint(ref, skipConfirm = false) {
    const cwd = selectedCwd();
    if (!cwd) { statusEl.textContent = "set a working directory first (Terminal pane)"; return; }
    const branchName = checkpointBranchName(ref);
    let deleteBranch = true;
    if (!skipConfirm) {
      if (!confirm("Delete this checkpoint?\n\nThis removes the git ref (refs/checkpoints/...). The snapshot commit may linger until git gc but can no longer be restored.")) return;
      deleteBranch = confirm(`Also delete the checkpoint branch ${branchName}?\n\nThis branch is unique to this checkpoint and safe to remove — it does not affect other checkpoints.`);
    }
    statusEl.textContent = "deleting…";
    try {
      const res = await fetch(window.apiUrl("/checkpoints/delete", { token: S.token }), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd, ref, deleteBranch }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) statusEl.textContent = "delete failed: " + window.SCOPE.escapeHtml(data.error || res.status);
      else {
        let s = "deleted " + window.SCOPE.escapeHtml(ref) + (data.deleteBranch ? " (branch removed)" : "");
        if (data.message) s += " — " + data.message;
        statusEl.textContent = s;
        loadCheckpoints();
      }
    } catch (e) {
      statusEl.textContent = "error: " + window.SCOPE.escapeHtml(String(e));
    }
  }

  btnCreate.onclick = createCheckpoint;
  btnRefresh.onclick = loadCheckpoints;

  window.__checkpointsOnView = function () { refreshCwd(); loadCheckpoints(); };
  window.__checkpointsOnSessions = function () {
    refreshCwd();
    const cwd = selectedCwd();
    if (cwd && cwd !== lastCwd) { lastCwd = cwd; loadCheckpoints(); }
  };
})();
