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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

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
        listEl.innerHTML = `<div class="empty-state">git unavailable in<br><code>${escapeHtml(cwd)}</code></div>`;
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
        const t = it.ts ? new Date(it.ts).toLocaleString() : "";
        meta.innerHTML = `<span class="cp-sha">${escapeHtml((it.sha || "").slice(0, 8))}</span> · ${escapeHtml(t)}`;
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
        row.appendChild(restore);
        row.appendChild(del);
        listEl.appendChild(row);
      }
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state">error: ${escapeHtml(String(e))}</div>`;
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
      if (!res.ok || !data.ok) statusEl.textContent = "failed: " + escapeHtml(data.error || res.status);
      else { statusEl.textContent = "created " + (data.sha || "").slice(0, 8); labelInput.value = ""; loadCheckpoints(); }
    } catch (e) {
      statusEl.textContent = "error: " + escapeHtml(String(e));
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
      if (!res.ok || !data.ok) statusEl.textContent = "restore failed: " + escapeHtml(data.error || res.status);
      else { statusEl.textContent = "restored to " + (data.sha || "").slice(0, 8); loadCheckpoints(); }
    } catch (e) {
      statusEl.textContent = "error: " + escapeHtml(String(e));
    }
  }

  async function deleteCheckpoint(ref) {
    const cwd = selectedCwd();
    if (!cwd) { statusEl.textContent = "set a working directory first (Terminal pane)"; return; }
    if (!confirm("Delete this checkpoint?\n\nThis removes the git ref (refs/checkpoints/...). The snapshot commit may linger until git gc but can no longer be restored.")) return;
    statusEl.textContent = "deleting…";
    try {
      const res = await fetch(window.apiUrl("/checkpoints/delete", { token: S.token }), {
        method: "POST",
        headers: { ...window.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ cwd, ref }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) statusEl.textContent = "delete failed: " + escapeHtml(data.error || res.status);
      else { statusEl.textContent = "deleted " + (ref.split("/").pop() || ref); loadCheckpoints(); }
    } catch (e) {
      statusEl.textContent = "error: " + escapeHtml(String(e));
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
