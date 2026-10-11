/**
 * office plugin — server half.
 *
 * The Office view's own state, moved out of the core server so the feature owns
 * it end to end (see plugins/README.md). It used to ride on `POST /agent-team`
 * and live in each workspace's `.pi/settings/agent-team-config.json`; it now has
 * its own `/office` route prefix and its own JSON store, namespaced per plugin
 * (`api.store` → `<plugins dir>/.data/office.json`), keyed by workspace.
 *
 *   GET  /office?cwd=<workspace>  → { officeName, tasks, runnerPaused }
 *   POST /office { action, cwd, … } → the same snapshot, after the write
 *
 * Actions: `setOfficeName`, `addTask`, `updateTask`, `moveTask`, `placeTask`,
 * `removeTask`, `setRunnerPaused`, plus the runner's own `beginRun` (the
 * single-runner lock + run-session record), `stopRun` (abort a live run) and
 * `failTask` (persist a failed dispatch so it is not retried). Validation is
 * unchanged from the core handlers (collapsed
 * whitespace, 60-char name, 200-char title, 4000-char brief, 200 tasks, the four
 * columns) so the board cannot be corrupted by a hand-edited store either.
 *
 * Disabled → `disabledPluginForRoute()` refuses `/office` with a 403, exactly
 * like the other feature plugins' routes.
 *
 * The plugin is self-contained on purpose: nothing here imports the app, so the
 * same directory also installs as a plain **user** plugin
 * (`cp -r apps/scope-server/plugins/office ~/.pi-scope/plugins/`), where it
 * overrides the built-in copy by id — that is how an upgraded Office ships
 * without a new build (see plugins/README.md).
 */

/** Columns, in board order: a planned task is worked FIFO by `plannedAt`. */
const TASK_STATUSES = ["todo", "planned", "in_progress", "done"];
const TASK_MAX = 200;
const TASK_NOTE_MAX = 4000;
const NAME_MAX = 60;
const TITLE_MAX = 200;
/** The store key holding `{ [workspace]: { officeName, tasks, runnerPaused } }`. */
const KEY = "workspaces";

const collapse = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** Clean stored tasks: keep usable rows, drop anything unreadable. */
function normaliseTasks(raw: unknown): Record<string, any>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= TASK_MAX) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, any>;
    const title = collapse(r.title).slice(0, TITLE_MAX);
    if (!title) continue;
    const id = String(r.id ?? "").trim() || `task_${Math.random().toString(36).slice(2, 12)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const status = TASK_STATUSES.includes(String(r.status)) ? String(r.status) : "todo";
    const task: Record<string, any> = { id, title, status };
    const note = collapse(r.note).slice(0, TASK_NOTE_MAX);
    if (note) task.note = note;
    for (const k of ["createdAt", "plannedAt", "startedAt", "finishedAt", "runStartedAt", "failedAt"]) {
      const v = Number(r[k]);
      if (Number.isFinite(v) && v > 0) task[k] = v;
    }
    // The chat session of the run this task is (or was) dispatched as. Persisted
    // so a page that reloads away can tell a still-running task from an orphan
    // instead of re-dispatching it (see runStates / `beginRun`).
    const runSessionId = String(r.runSessionId ?? "").trim();
    if (runSessionId) task.runSessionId = runSessionId;
    out.push(task);
  }
  return out;
}

/** The stored office state for one workspace, cleaned. */
function normaliseState(raw: any): { officeName?: string; tasks: Record<string, any>[]; runnerPaused: boolean } {
  const name = collapse(raw && raw.officeName).slice(0, NAME_MAX);
  return {
    officeName: name || undefined,
    tasks: normaliseTasks(raw && raw.tasks),
    // The queue runner starts PAUSED: a task parked in Planned waits for the
    // user to press Run. Anything but an explicit `false` means paused.
    runnerPaused: !(raw && raw.runnerPaused === false),
  };
}

export function activate(api: any): void {
  const { jsonResponse, readBody } = api.kit;
  // This plugin is installable as a *user* plugin (drop it in
  // ~/.pi-scope/plugins/office and it overrides the built-in copy), so every
  // host primitive is feature-detected: an older host that lacks one still runs
  // the plugin, just without the workspace resolution / legacy import.
  const resolveProjectDir: (cwd: string | null) => string | null =
    api.kit.resolveProjectDir ?? ((cwd) => cwd);

  /** The workspace this request's office state belongs to. */
  const workspaceOf = (cwd: unknown) => String(resolveProjectDir(cwd ? String(cwd) : null) ?? "default");

  const readAll = (): Record<string, any> => {
    const all = api.store.get(KEY, {});
    return all && typeof all === "object" ? all : {};
  };

  /** The state for `workspace`, seeding it once from the pre-plugin location so
   *  an existing name and board survive the move into plugin-owned storage. */
  function readState(workspace: string): { officeName?: string; tasks: Record<string, any>[]; runnerPaused: boolean } {
    const all = readAll();
    if (workspace in all) return normaliseState(all[workspace]);
    const legacy = api.kit.legacyOfficeState?.(workspace);
    if (legacy) {
      const seeded = normaliseState(legacy);
      all[workspace] = seeded;
      api.store.set(KEY, all);
      return seeded;
    }
    return normaliseState(null);
  }

  /** Live run status (from the chat manager) for every task that dispatched one.
   *  Feature-detected so the plugin still runs on a host that predates the hook. */
  function runStates(state: any): Record<string, any> {
    const status = api.kit.chatRunStatus;
    const out: Record<string, any> = {};
    if (typeof status !== "function") return out;
    for (const t of state.tasks || []) if (t && t.runSessionId) out[t.id] = status(String(t.runSessionId));
    return out;
  }

  /** Attach the derived run map (only when there is one) and the capability flag
   *  that tells the client whether the SERVER runs the queue (vs the client
   *  falling back to dispatching it itself). */
  function withRuns(state: any) {
    const out: any = { ...state, serverRunner: typeof api.kit.startChat === "function" };
    const runs = runStates(state);
    if (Object.keys(runs).length) out.runStates = runs;
    return out;
  }

  /** The wire shape: stored state plus the derived, never-stored live run map. */
  function snapshot(workspace: string) {
    return withRuns(readState(workspace));
  }

  function commit(workspace: string, mutate: (state: any) => any): any {
    const all = readAll();
    const next = mutate(readState(workspace));
    all[workspace] = next;
    api.store.set(KEY, all);
    return withRuns(normaliseState(next));
  }

  /** A just-begun run may not have created its chat session yet; never self-heal
   *  an In Progress task younger than this, so a dispatch in flight is safe. */
  const RUN_GRACE_MS = 20_000;

  /**
   * Read-time self-heal: the runner works one task at a time and records the
   * chat session of every dispatch, so an In Progress task with no live run is a
   * leftover — a run that finished while no page was open, a session that died
   * with the server, or an old/manual board entry. Reconcile it here so a stale
   * board heals on any read, with no page needed to recover it.
   *
   * Only unambiguous cases are touched, and only once past the grace window:
   * a fresh dispatch (or a fresh drag) is always left alone.
   */
  function reconcile(workspace: string): void {
    const status = api.kit.chatRunStatus;
    if (typeof status !== "function") return; // no chat state to judge against
    const state = readState(workspace);
    const now = Date.now();
    let changed = false;
    for (const t of state.tasks) {
      if (t.status !== "in_progress") continue;
      const runAge = now - Number(t.runStartedAt || t.startedAt || 0);
      if (!t.runSessionId) {
        // No dispatch recorded (a manual move, or a board from before the run
        // session was tracked). Heal it once it is clearly not a fresh drag.
        if (runAge > RUN_GRACE_MS) { t.status = "planned"; t.plannedAt = t.plannedAt || now; changed = true; }
        continue;
      }
      const rs = status(String(t.runSessionId));
      if (rs.active) continue;                 // live — leave it alone
      if (rs.present && rs.outcome) {
        // Finished while nobody was watching: settle from the recorded outcome.
        if (rs.outcome === "done") {
          t.status = "done"; t.finishedAt = now;
        } else {
          t.status = "planned"; t.plannedAt = t.plannedAt || now;
          // A paused run (aborted) waits for Run to pick it up again; an errored
          // run is marked failed so the runner never retries it on its own.
          if (rs.outcome === "error") t.failedAt = now;
        }
        delete t.runSessionId; delete t.runStartedAt;
        changed = true;
        continue;
      }
      if (!rs.present && runAge > RUN_GRACE_MS) {
        // The session is gone (e.g. the server restarted): return the task.
        t.status = "planned"; t.plannedAt = t.plannedAt || now;
        delete t.runSessionId; delete t.runStartedAt;
        changed = true;
      }
    }
    if (changed) {
      const all = readAll();
      all[workspace] = state;
      api.store.set(KEY, all);
    }
  }

  // ─── The server-side queue runner ─────────────────────────────────────────
  // The queue runs HERE, not in the browser: each dispatch is a real `pi` run
  // the plugin owns and consumes, so it keeps advancing after the page that
  // started it is closed. The browser is only a controller (Run/Pause) and a
  // viewer. On a host whose kit lacks `startChat` the snapshot reports
  // `serverRunner: false` and the client falls back to running the queue itself.
  const RUNNERS = new Map<string, { sessionId: string }>();
  let disposed = false; // the plugin was disabled/reloaded — stop pumping
  const serverRunnerEnabled = () => typeof api.kit.startChat === "function";

  /** Settle a finished run into its column (Done / Planned / failed). */
  function settleRun(workspace: string, id: string, outcome: string): void {
    commit(workspace, (current) => {
      const task = current.tasks.find((t: any) => t.id === id);
      if (!task) return current;
      const at = Date.now();
      if (outcome === "done") {
        task.status = "done"; task.finishedAt = at;
      } else {
        task.status = "planned"; task.plannedAt = task.plannedAt || at;
        if (outcome === "error") task.failedAt = at;   // a failed run waits for the user
      }
      delete task.runSessionId; delete task.runStartedAt; delete task.startedAt;
      return current;
    });
  }

  /** Read one dispatch's NDJSON stream to its end and report how it settled. */
  async function consumeRun(res: any): Promise<"done" | "error" | "aborted"> {
    if (!res || !res.ok || !res.body) return "error";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", settled = false, aborted = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: any = null;
          try { ev = JSON.parse(line); } catch { continue; }
          // A `done` carrying `aborted` is pi acknowledging a stop (Pause asked
          // the server to abort the run) — never a successful finish.
          if (ev && ev.type === "done") { if (ev.aborted) aborted = true; else settled = !ev.error; }
        }
      }
    } catch { return "error"; }
    if (aborted) return "aborted";
    return settled ? "done" : "error";
  }

  /** Dispatch the next planned task, then continue the queue when it settles. */
  /** Fire-and-forget entry point: the runner must never reject (a stray
   *  rejection would take the whole server down), so all errors are swallowed. */
  async function pump(workspace: string): Promise<void> {
    try { await pumpOnce(workspace); } catch { /* a dispatch must not crash the server */ }
  }

  async function pumpOnce(workspace: string): Promise<void> {
    if (disposed) return;                                      // the plugin is going away
    if (!serverRunnerEnabled()) return;
    if (RUNNERS.has(workspace)) return;                        // a run is already live
    const state = readState(workspace);
    if (state.runnerPaused !== false) return;                  // the runner is held
    if (state.tasks.some((t: any) => t.status === "in_progress")) return; // reconcile owns it
    const next = state.tasks
      .filter((t: any) => t.status === "planned" && !t.failedAt)
      .sort((a: any, b: any) => (a.plannedAt || a.createdAt || 0) - (b.plannedAt || b.createdAt || 0))[0];
    if (!next) return;

    const sessionId = `office_${crypto.randomUUID()}`;
    let began = false;
    commit(workspace, (current) => {
      const task = current.tasks.find((t: any) => t.id === next.id);
      if (!task || task.status !== "planned") return current;
      began = true;
      const at = Date.now();
      task.status = "in_progress";
      task.startedAt = task.startedAt || at;
      delete task.finishedAt; delete task.failedAt;
      task.runSessionId = sessionId;
      task.runStartedAt = at;
      return current;
    });
    if (!began) return;

    RUNNERS.set(workspace, { sessionId });
    try {
      const model = String(api.kit.readSettingsJson?.().defaultModel || "");
      const prompt = next.note ? `${next.title}\n\n${next.note}` : String(next.title);
      const libraryBlock = api.kit.libraryBlockFor ? api.kit.libraryBlockFor(workspace) : "";
      const res = api.kit.startChat({ cwd: workspace, model, prompt, sessionId, libraryBlock });
      settleRun(workspace, next.id, await consumeRun(res));
    } catch {
      settleRun(workspace, next.id, "error");
    } finally {
      RUNNERS.delete(workspace);
    }
    void pump(workspace);                                      // continue the queue
  }

  /** Stop the run this workspace has live, if any (Pause). */
  function stopActiveRun(workspace: string): void {
    const run = RUNNERS.get(workspace);
    if (run && typeof api.kit.stopChat === "function") api.kit.stopChat(run.sessionId);
  }

  // A run in flight when the plugin is disabled or reloaded must not keep a pi
  // process alive with no owner: stop pumping (so the queue does not just
  // re-dispatch the aborted task) and abort each live run — its task returns to
  // Planned through the aborted stream. A later enable resumes it.
  api.onDispose?.(() => {
    disposed = true;
    for (const workspace of [...RUNNERS.keys()]) stopActiveRun(workspace);
  });

  api.route("GET", "/office", (ctx) => {
    const workspace = workspaceOf(ctx.url.searchParams.get("cwd"));
    reconcile(workspace);
    return snapshot(workspace);
  });

  api.route("POST", "/office", async (ctx) => {
    let body: any;
    try { body = JSON.parse(await readBody(ctx.req)); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const workspace = workspaceOf(body?.cwd);
    // Heal a stale board before acting, so a lock check sees the truth.
    reconcile(workspace);
    const action = String(body?.action ?? "");

    switch (action) {
      case "setOfficeName": {
        const name = collapse(body.name);
        if (name.length > NAME_MAX) return jsonResponse({ error: `office names may be up to ${NAME_MAX} characters` }, 400);
        return jsonResponse(commit(workspace, (state) => {
          state.officeName = name || undefined;
          return state;
        }));
      }
      case "addTask": {
        const title = collapse(body.title);
        const note = collapse(body.note).slice(0, TASK_NOTE_MAX);
        if (!title) return jsonResponse({ error: "missing title" }, 400);
        if (title.length > TITLE_MAX) return jsonResponse({ error: `task titles may be up to ${TITLE_MAX} characters` }, 400);
        let full = false;
        const state = commit(workspace, (current) => {
          if (current.tasks.length >= TASK_MAX) { full = true; return current; }
          const task: Record<string, any> = {
            id: `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
            title,
            status: "todo",
            createdAt: Date.now(),
          };
          if (note) task.note = note;
          current.tasks.push(task);
          return current;
        });
        if (full) return jsonResponse({ error: `the board is full (${TASK_MAX} tasks)` }, 400);
        return jsonResponse(state);
      }
      case "moveTask": {
        const id = String(body.id ?? "").trim();
        const status = String(body.status ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        if (!TASK_STATUSES.includes(status)) return jsonResponse({ error: `invalid status: ${status}` }, 400);
        let found = false;
        let busy = false;
        const state = commit(workspace, (current) => {
          const task = current.tasks.find((t: any) => t.id === id);
          if (!task) return current;
          // At most one task may sit In Progress (the runner owns it). A manual
          // move into a busy In Progress column is refused, so it cannot wedge
          // the runner behind a second "running" task.
          if (status === "in_progress" && current.tasks.some((t: any) => t.status === "in_progress" && t.id !== id)) {
            busy = true; return current;
          }
          found = true;
          const at = Date.now();
          task.status = status;
          // A move is the user (or the runner) touching the task: it re-arms a
          // task that previously failed.
          delete task.failedAt;
          // Stamp the column the task entered: Planned is worked FIFO by
          // plannedAt, and the timestamps drive the board's own labels.
          if (status === "planned") task.plannedAt = task.plannedAt || at;
          if (status === "todo") { delete task.plannedAt; delete task.startedAt; delete task.finishedAt; }
          if (status === "in_progress") task.startedAt = task.startedAt || at;
          if (status === "done") task.finishedAt = at;
          // Leaving In Progress ends any recorded run: the task is no longer
          // owned by a chat session.
          if (status !== "in_progress") { delete task.runSessionId; delete task.runStartedAt; }
          return current;
        });
        if (busy) return jsonResponse({ error: "another task is already running", code: "conflict" }, 409);
        if (!found) return jsonResponse({ error: "no such task" }, 404);
        if (status === "planned") void pump(workspace);   // hand it to the server runner
        return jsonResponse(state);
      }
      case "updateTask": {
        // Rewrite a task's title and brief in place. The status is untouched:
        // the board only offers this while the task is still in Todo.
        const id = String(body.id ?? "").trim();
        const title = collapse(body.title);
        const note = collapse(body.note).slice(0, TASK_NOTE_MAX);
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        if (!title) return jsonResponse({ error: "missing title" }, 400);
        if (title.length > TITLE_MAX) return jsonResponse({ error: `task titles may be up to ${TITLE_MAX} characters` }, 400);
        let found = false;
        const state = commit(workspace, (current) => {
          const task = current.tasks.find((t: any) => t.id === id);
          if (!task) return current;
          found = true;
          task.title = title;
          if (note) task.note = note; else delete task.note;
          return current;
        });
        if (!found) return jsonResponse({ error: "no such task" }, 404);
        return jsonResponse(state);
      }
      case "placeTask": {
        // Drop a task at a position: the drag-and-drop primitive. It sets the
        // column (like `moveTask`) and, when the target is Planned, splices the
        // task into the queue immediately BEFORE `beforeId` (an empty/unknown
        // `beforeId` appends). Planned is worked FIFO by `plannedAt`, so the
        // whole queue's `plannedAt` is rewritten strictly increasing — the base
        // sits just in the past so a task planned later still sorts to the back.
        const id = String(body.id ?? "").trim();
        const status = String(body.status ?? "").trim();
        const beforeId = body.beforeId == null ? "" : String(body.beforeId).trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        if (!TASK_STATUSES.includes(status)) return jsonResponse({ error: `invalid status: ${status}` }, 400);
        let found = false;
        let busy = false;
        const state = commit(workspace, (current) => {
          const task = current.tasks.find((t: any) => t.id === id);
          if (!task) return current;
          // Same one-at-a-time guard as `moveTask`: a drag onto a busy In
          // Progress column is refused rather than starting a second run.
          if (status === "in_progress" && current.tasks.some((t: any) => t.status === "in_progress" && t.id !== id)) {
            busy = true; return current;
          }
          found = true;
          const at = Date.now();
          task.status = status;
          // A drag/keyboard move re-arms a task that previously failed.
          delete task.failedAt;
          if (status === "planned") task.plannedAt = task.plannedAt || at;
          if (status === "todo") { delete task.plannedAt; delete task.startedAt; delete task.finishedAt; }
          if (status === "in_progress") task.startedAt = task.startedAt || at;
          if (status === "done") task.finishedAt = at;
          // Leaving In Progress ends any recorded run: the task is no longer
          // owned by a chat session.
          if (status !== "in_progress") { delete task.runSessionId; delete task.runStartedAt; }
          if (status === "planned") {
            const queue = current.tasks
              .filter((t: any) => t.status === "planned")
              .sort((a: any, b: any) => (a.plannedAt || a.createdAt || 0) - (b.plannedAt || b.createdAt || 0))
              .filter((t: any) => t.id !== id);
            let idx = beforeId ? queue.findIndex((t: any) => t.id === beforeId) : -1;
            if (idx < 0) idx = queue.length; // unknown/absent target → append
            queue.splice(idx, 0, task);
            const base = Date.now() - queue.length;
            queue.forEach((t: any, i: number) => { t.plannedAt = base + i; });
          }
          return current;
        });
        if (busy) return jsonResponse({ error: "another task is already running", code: "conflict" }, 409);
        if (!found) return jsonResponse({ error: "no such task" }, 404);
        if (status === "planned") void pump(workspace);   // hand it to the server runner
        return jsonResponse(state);
      }
      case "beginRun": {
        // The queue runner announcing the chat session it is about to dispatch
        // this task as. Recorded in ONE write with the move to In Progress, so a
        // page that reloads while the run is live finds the session id and can
        // tell the still-running task from an orphaned one.
        //
        // The write is the single-runner LOCK: the office works one task at a
        // time, so a second dispatch (a racing tab, a stale board) that finds any
        // task already In Progress is refused instead of starting a parallel run.
        const id = String(body.id ?? "").trim();
        const sessionId = String(body.sessionId ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        if (!sessionId) return jsonResponse({ error: "missing sessionId" }, 400);
        let found = false;
        let busy = false;
        const state = commit(workspace, (current) => {
          if (current.tasks.some((t: any) => t.status === "in_progress")) { busy = true; return current; }
          const task = current.tasks.find((t: any) => t.id === id);
          if (!task) return current;
          found = true;
          task.status = "in_progress";
          task.startedAt = task.startedAt || Date.now();
          delete task.finishedAt;
          delete task.failedAt;          // a fresh dispatch clears the last failure
          task.runSessionId = sessionId;
          // Fresh stamp for THIS run, used by the read-time self-heal so a run
          // that is only just starting is never mistaken for a stale one.
          task.runStartedAt = Date.now();
          return current;
        });
        if (busy) return jsonResponse({ error: "another task is already running", code: "conflict" }, 409);
        if (!found) return jsonResponse({ error: "no such task" }, 404);
        return jsonResponse(state);
      }
      case "stopRun": {
        // Stop a live run — the one this page dispatched, or an adopted one — so
        // Pause really halts pi instead of only dropping the browser's stream.
        // The pi session is aborted and the task handed back to Planned.
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        let stopped: string | null = null;
        const state = commit(workspace, (current) => {
          const task = current.tasks.find((t: any) => t.id === id);
          if (!task) return current;
          stopped = task.runSessionId || null;
          task.status = "planned";
          task.plannedAt = task.plannedAt || Date.now();
          delete task.runSessionId;
          delete task.runStartedAt;
          delete task.startedAt;
          return current;
        });
        if (stopped && typeof api.kit.stopChat === "function") api.kit.stopChat(String(stopped));
        return jsonResponse(state);
      }
      case "failTask": {
        // A dispatch that could not run (or errored) is marked failed, not just
        // returned to Planned: the runner skips failed tasks so it cannot spin on
        // a doomed one — and the mark is PERSISTED, so a reload does not silently
        // retry it. The user re-arms it by moving the card again (or a fresh
        // `beginRun` clears it).
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        let found = false;
        const state = commit(workspace, (current) => {
          const task = current.tasks.find((t: any) => t.id === id);
          if (!task) return current;
          found = true;
          const at = Date.now();
          task.status = "planned";
          task.plannedAt = task.plannedAt || at;
          task.failedAt = at;
          delete task.runSessionId;
          delete task.runStartedAt;
          delete task.startedAt;
          return current;
        });
        if (!found) return jsonResponse({ error: "no such task" }, 404);
        return jsonResponse(state);
      }
      case "removeTask": {
        const id = String(body.id ?? "").trim();
        if (!id) return jsonResponse({ error: "missing id" }, 400);
        return jsonResponse(commit(workspace, (current) => {
          current.tasks = current.tasks.filter((t: any) => t.id !== id);
          return current;
        }));
      }
      case "setRunnerPaused": {
        // Paused (true) is the default: the runner hands nothing to the
        // orchestrator until it is switched off.
        const paused = body.paused !== false;
        const state = commit(workspace, (current) => {
          current.runnerPaused = paused;
          return current;
        });
        // The server owns the queue: Run starts (or resumes) it, Pause stops the
        // run in flight — the task returns to Planned via its aborted stream.
        if (paused) stopActiveRun(workspace);
        else void pump(workspace);
        return jsonResponse(state);
      }
      case "pump": {
        // A nudge from the controller (e.g. a page opened on a board left
        // running): start the queue if it is not already going. Idempotent.
        void pump(workspace);
        return jsonResponse(snapshot(workspace));
      }
      default:
        return jsonResponse({ error: `unknown action: ${action}` }, 400);
    }
  });

  // Resume queues left running when the server last stopped: the store says
  // which workspaces had the runner on, and the runner is browser-free. Reconcile
  // first so a run orphaned by the restart is returned to Planned before the
  // queue starts. A workspace left PAUSED (the default) resumes nothing.
  if (serverRunnerEnabled()) {
    for (const workspace of Object.keys(readAll())) {
      if (readState(workspace).runnerPaused !== false) continue;
      reconcile(workspace);
      void pump(workspace);
    }
  }
}
