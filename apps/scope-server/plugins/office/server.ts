/**
 * office plugin — server half.
 *
 * The Office view's own state, moved out of the core server so the feature owns
 * it end to end (see plugins/README.md). It used to ride on `POST /agent-team`
 * and live in each workspace's `.pi/settings/agent-team-config.json`; it now has
 * its own `/office` route prefix and — because a board belongs to a project, not
 * to the plugin install — its own **project-scoped** JSON store,
 * `<workspace>/.pi-scope/plugins/.data/office.json` (`api.projectStore`).
 *
 * The plugin's global `api.store` is now only a migration source and an index:
 * it keeps `projects` (the workspace dirs it has seen) so a queue left running
 * can be resumed at boot, and any pre-move `workspaces` bucket is migrated into
 * the project's own file on first read and removed from the global file.
 *
 *   GET  /office?cwd=<workspace>  → { officeName, tasks, runnerPaused, runStates? }
 *   POST /office { action, cwd, … } → the same snapshot, after the write
 *
 * Actions: `setOfficeName`, `addTask`, `updateTask`, `moveTask`, `placeTask`,
 * `removeTask`, `setRunnerPaused`, plus the runner's own `beginRun` (the
 * single-runner lock + run-session record), `stopRun` (abort a live run) and
 * `failTask` (persist a failed dispatch so it is not retried). Validation is
 * unchanged from the core handlers (collapsed
 * whitespace, 60-char name, 200-char title, 4000-char brief, 200 tasks, the five
 * columns) so the board cannot be corrupted by a hand-edited store either.
 *
 * `runStates` is the derived half of the snapshot (never stored): the live chat
 * status of every task that dispatched a run, plus the `pending` host dialog a
 * blocked run is sitting on. A run blocked on a question parks its task in the
 * **Waiting** column (see `reconcile`), where the board shows it until a human
 * answers and the run moves on.
 *
 * The board is not the only way to put the orchestrator to work: a prompt typed
 * in Chat starts the same kind of run without ever touching the board. Those
 * runs are **adopted** — `adoptRuns` writes them in as ordinary tasks (marked
 * `source: "run"`, titled with the prompt, In Progress with the run's own
 * clock), so the board shows what the orchestrator is on whichever way it was
 * started, and their history lands in Done like everything else. Adoption ties
 * the card to the run through the same `runSessionId` every dispatched task
 * carries, so `reconcile` settles it, the queue waits behind it (one run at a
 * time), and taking the card off the board mutes that run instead of letting it
 * be adopted straight back.
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

import * as path from "node:path";

/** Columns, in board order: a planned task is worked FIFO by `plannedAt`.
 *
 *  `waiting` is where a running task PARKS itself while its run is blocked on a
 *  host dialog (`ask_user_question`): the run is still live — so it still holds
 *  the one-at-a-time runner — but nothing can move until a human answers. It is
 *  never dispatched TO (only `reconcile` writes it, and the user may drag a card
 *  there); answering the question moves the task back to In Progress. */
const TASK_STATUSES = ["todo", "planned", "in_progress", "waiting", "done"];
/** The columns a live run owns: at most ONE task may sit in either. */
const HELD_STATUSES = new Set(["in_progress", "waiting"]);
const isHeld = (t: any) => HELD_STATUSES.has(String(t?.status ?? ""));
const TASK_MAX = 200;
const TASK_NOTE_MAX = 4000;
const NAME_MAX = 60;
const TITLE_MAX = 200;
/** Runs the board never adopts: a Workflow node's own `pi` run is that view's
 *  business, not a task on this board (see `adoptRuns`). */
const FOREIGN_RUN_RE = /^wf_/;
/** How many taken-off-the-board runs are remembered so they are not adopted
 *  straight back (see `muteRun`). A handful is plenty: it only has to outlive
 *  the run that was dismissed. */
const MUTED_MAX = 50;
/** The store key holding `{ [workspace]: { officeName, tasks, runnerPaused } }`. */
const KEY = "workspaces";
/** The global store's index of project dirs (see `rememberProject`). */
const INDEX_KEY = "projects";
/** How often the board sweeps for the orchestrator's own runs when no page is
 *  open (see `sweep`) — and how fast an ingested event may trigger one. */
const SWEEP_MS = 4_000;
const SWEEP_EVENT_MS = 1_000;

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
    // A card the board wrote itself for a run it did not start (see adoptRuns):
    // kept so the card can say where it came from.
    if (r.source === "run") task.source = "run";
    out.push(task);
  }
  return out;
}

/** Runs the user took off the board, as `{ sid, at }`: a run adopted for `sid`
 *  with a start no later than `at` stays off (see `muteRun`). */
function normaliseMuted(raw: unknown): { sid: string; at: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { sid: string; at: number }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, any>;
    const sid = String(r.sid ?? "").trim();
    const at = Number(r.at);
    if (!sid || !Number.isFinite(at) || at <= 0) continue;
    out.push({ sid, at });
  }
  return out.slice(-MUTED_MAX);
}

/** The stored office state for one workspace, cleaned. */
function normaliseState(raw: any): { officeName?: string; tasks: Record<string, any>[]; runnerPaused: boolean; muted: { sid: string; at: number }[] } {
  const name = collapse(raw && raw.officeName).slice(0, NAME_MAX);
  return {
    officeName: name || undefined,
    tasks: normaliseTasks(raw && raw.tasks),
    // The queue runner starts PAUSED: a task parked in Planned waits for the
    // user to press Run. Anything but an explicit `false` means paused.
    runnerPaused: !(raw && raw.runnerPaused === false),
    muted: normaliseMuted(raw && raw.muted),
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

  // ── Storage ───────────────────────────────────────────────────────────────
  // The board is project state, so it lives in the project: `api.projectStore`
  // → `<workspace>/.pi-scope/plugins/.data/office.json`. A host that predates
  // the helper (or a workspace that is not a real directory) falls back to the
  // plugin's global store, so this stays installable everywhere.
  const hasProjectStore = typeof api.projectStore === "function";
  const storeFor = (workspace: string) => (hasProjectStore ? api.projectStore(workspace) : api.store);
  const readStoreAll = (workspace: string): Record<string, any> => {
    const all = storeFor(workspace).get(KEY, {});
    return all && typeof all === "object" ? all : {};
  };

  /** The workspaces this plugin has seen, so a queue left running can be resumed
   *  at boot (project files cannot be enumerated from the plugin). */
  const knownProjects = (): string[] => {
    const list = api.store.get(INDEX_KEY, []);
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  };
  function rememberProject(workspace: string): void {
    if (!hasProjectStore || !path.isAbsolute(workspace)) return;
    const list = knownProjects();
    if (!list.includes(workspace)) {
      list.push(workspace);
      api.store.set(INDEX_KEY, list);
    }
  }

  /** A workspace's bucket in the old global store, if it has not migrated yet. */
  function globalBucket(workspace: string): any {
    const all = api.store.get(KEY, {});
    return all && typeof all === "object" ? all[workspace] : undefined;
  }
  function dropGlobalBucket(workspace: string): void {
    const all = api.store.get(KEY, {});
    if (all && typeof all === "object" && workspace in all) {
      delete all[workspace];
      api.store.set(KEY, all);
    }
  }

  /** The state for `workspace`, seeding it once from the pre-plugin location or
   *  the old global store so an existing name and board survive the move. */
  function readState(workspace: string): { officeName?: string; tasks: Record<string, any>[]; runnerPaused: boolean; muted: { sid: string; at: number }[] } {
    const store = storeFor(workspace);
    rememberProject(workspace);
    const all = readStoreAll(workspace);
    if (workspace in all) return normaliseState(all[workspace]);
    const legacy = globalBucket(workspace) ?? api.kit.legacyOfficeState?.(workspace);
    const seeded = normaliseState(legacy);
    all[workspace] = seeded;
    store.set(KEY, all);
    if (globalBucket(workspace) !== undefined) dropGlobalBucket(workspace);
    return seeded;
  }

  /** The host dialog a task's run is blocked on, or null. Feature-detected: a
   *  host that predates the hook simply has no Waiting column (its tasks never
   *  leave In Progress), instead of the plugin failing to load. */
  function pendingDialogFor(sessionId: any): { id: string; kind: string; title: string; options: string[] } | null {
    const pending = api.kit.chatPendingDialog;
    if (typeof pending !== "function" || !sessionId) return null;
    try { return pending(String(sessionId)) || null; } catch { return null; }
  }

  /** Live run status (from the chat manager) for every task that dispatched one.
   *  Feature-detected so the plugin still runs on a host that predates the hook.
   *  A run blocked on a question carries that question as `pending`, so the board
   *  can say WHAT the orchestrator is waiting on, not just that it is waiting. */
  function runStates(state: any): Record<string, any> {
    const status = api.kit.chatRunStatus;
    const out: Record<string, any> = {};
    if (typeof status !== "function") return out;
    for (const t of state.tasks || []) {
      if (!t || !t.runSessionId) continue;
      const id = String(t.runSessionId);
      const rs = status(id);
      const pending = pendingDialogFor(id);
      if (pending) rs.pending = pending;
      out[t.id] = rs;
    }
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

  /** The wire shape: stored state plus the derived, never-stored live run map.
   *  `muted` is the board's own bookkeeping (which runs the user took off it) and
   *  never leaves the server. */
  const wireState = (state: any) => ({
    officeName: state.officeName,
    tasks: state.tasks,
    runnerPaused: state.runnerPaused,
  });

  function snapshot(workspace: string) {
    return withRuns(wireState(readState(workspace)));
  }

  function commit(workspace: string, mutate: (state: any) => any): any {
    const store = storeFor(workspace);
    const next = mutate(readState(workspace));
    const all = readStoreAll(workspace);
    all[workspace] = next;
    store.set(KEY, all);
    return withRuns(wireState(normaliseState(next)));
  }

  /** Persist a state `reconcile`/`adoptRuns` already mutated in memory. */
  function writeState(workspace: string, state: any): void {
    const store = storeFor(workspace);
    const all = readStoreAll(workspace);
    all[workspace] = state;
    store.set(KEY, all);
  }

  /** Remember a run the user took OFF the board — its card deleted, dragged out
   *  of the run columns, or stopped — so the sweep does not adopt it straight
   *  back while it is still live. One entry per session, refreshed, and only the
   *  newest handful are kept. */
  function muteRun(state: any, sessionId: unknown, at?: number): void {
    const sid = String(sessionId ?? "").trim();
    if (!sid) return;
    const muted = normaliseMuted(state.muted).filter((m) => m.sid !== sid);
    muted.push({ sid, at: Number(at) || Date.now() });
    state.muted = muted.slice(-MUTED_MAX);
  }

  /**
   * Adopt the orchestrator's own runs as board cards.
   *
   * A prompt typed in Chat starts the same kind of `pi` run the board dispatches
   * — it just never touches the board, so without this the board reads "idle"
   * while the orchestrator is plainly busy. Every live run in this workspace that
   * no task owns is written in (In Progress, titled with the prompt, wearing the
   * run's own clock), and `reconcile` settles it into Done like any other task,
   * so the board keeps the history of work it did not start.
   *
   * Only live runs can be adopted — a settled one keeps no prompt — so the sweep
   * runs while the run is going (see `sweep`). The runs the board itself owns are
   * skipped: the queue's live dispatch, any task's recorded `runSessionId`, and
   * the Workflow's own node runs.
   */
  function adoptRuns(workspace: string, state: any): boolean {
    const liveRuns = api.kit.chatLiveRuns;
    if (typeof liveRuns !== "function") return false; // no chat state to read
    let runs: any[];
    try { runs = liveRuns() || []; } catch { return false; }
    const owned = new Set<string>();
    for (const t of state.tasks) if (t.runSessionId) owned.add(String(t.runSessionId));
    const muted = normaliseMuted(state.muted);
    const isMuted = (sid: string, startedAt: number) => muted.some((m) => m.sid === sid && m.at >= startedAt);
    const queue = RUNNERS.get(workspace);
    const queueSid = queue ? String(queue.sessionId) : "";
    let changed = false;
    for (const r of runs) {
      if (!r || !r.active || !r.prompt || r.fresh) continue;   // a live, prompted run
      if (workspaceOf(r.cwd) !== workspace) continue;
      const sid = String(r.sessionId ?? "").trim();
      if (!sid || owned.has(sid) || sid === queueSid || FOREIGN_RUN_RE.test(sid)) continue;
      const startedAt = Number(r.startedAt) || Date.now();
      if (isMuted(sid, startedAt)) continue;
      if (state.tasks.length >= TASK_MAX) break;               // the board is full
      const prompt = collapse(r.prompt);
      const title = prompt.slice(0, TITLE_MAX);
      if (!title) continue;
      const task: Record<string, any> = {
        id: `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
        title,
        status: "in_progress",
        createdAt: startedAt,
        startedAt,
        runStartedAt: startedAt,
        runSessionId: sid,
        source: "run",
      };
      const brief = prompt.slice(0, TASK_NOTE_MAX);
      if (brief.length > title.length) task.note = brief;
      state.tasks.push(task);
      changed = true;
    }
    return changed;
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
   * It is also what MOVES a task between In Progress and Waiting: a live run
   * blocked on a host dialog (`ask_user_question`) is parked in Waiting, and the
   * moment the answer lands the run is unblocked and the task returns to In
   * Progress. Both are reads of the same run state, so the board tells the truth
   * on any poll — including for a run started by a page that is no longer open.
   *
   * It first ADOPTS the orchestrator's own runs (see `adoptRuns`), so the rest of
   * this pass sees them as the ordinary tasks they now are.
   *
   * Only unambiguous cases are touched, and only once past the grace window:
   * a fresh dispatch (or a fresh drag) is always left alone.
   */
  function reconcile(workspace: string): void {
    const status = api.kit.chatRunStatus;
    const state = readState(workspace);
    const now = Date.now();
    let changed = adoptRuns(workspace, state);
    if (typeof status !== "function") {   // no chat state to judge against
      if (changed) writeState(workspace, state);
      return;
    }
    for (const t of state.tasks) {
      const held = isHeld(t);
      if (!held) continue;
      const runAge = now - Number(t.runStartedAt || t.startedAt || 0);
      if (!t.runSessionId) {
        // No dispatch recorded. On In Progress that is a leftover (a manual move,
        // or a board from before the run session was tracked): heal it once it is
        // clearly not a fresh drag. Waiting is a legitimate resting place for a
        // card the user put there themselves, so it is left where it is.
        if (t.status === "in_progress" && runAge > RUN_GRACE_MS) { t.status = "planned"; t.plannedAt = t.plannedAt || now; changed = true; }
        continue;
      }
      const rs = status(String(t.runSessionId));
      if (rs.active) {
        // Live. Blocked on a question → Waiting; otherwise it is being worked on
        // → In Progress. This one line is the whole auto-move, in both
        // directions: answering the question flips it back.
        const want = pendingDialogFor(t.runSessionId) ? "waiting" : "in_progress";
        if (t.status !== want) { t.status = want; changed = true; }
        continue;
      }
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
    if (changed) writeState(workspace, state);
  }

  /**
   * Keep every known board in step with the orchestrator's own runs — the ones
   * started with no page open and no board involved (a prompt in Chat).
   *
   * `reconcile` has to run while a run is LIVE to adopt it (a settled run keeps
   * no prompt) and again after it ends to settle the card, so the plugin drives
   * itself: a slow timer for the settling, and an ingested event as the hint that
   * a workspace is at work right now (a run can be over in well under a sweep).
   *
   * Only boards with something to do are touched — a live run in that workspace,
   * or a card the board itself holds — so a dormant install costs a map lookup.
   */
  function sweep(): void {
    if (disposed) return;
    if (typeof api.kit.chatLiveRuns !== "function") return;
    let runs: any[];
    try { runs = api.kit.chatLiveRuns() || []; } catch { return; }
    const busy = new Set<string>();
    for (const r of runs) if (r && r.active && r.prompt) busy.add(workspaceOf(r.cwd));
    for (const workspace of knownProjects()) {
      if (!busy.has(workspace) && !readState(workspace).tasks.some(isHeld)) continue;
      reconcile(workspace);
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
    if (state.tasks.some(isHeld)) return;                     // a task holds the run: reconcile owns it
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

  // The orchestrator keeps working with no page open, so the board learns about
  // its runs on its own: a slow timer settles what it adopted, and an ingested
  // event (throttled — a streaming turn posts them far faster than the board can
  // change) is the near-instant hint that a run has just started.
  const sweepTimer = setInterval(sweep, SWEEP_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  let lastEventSweep = 0;
  api.onEvent?.(() => {
    const now = Date.now();
    if (now - lastEventSweep < SWEEP_EVENT_MS) return;
    lastEventSweep = now;
    sweep();
  });
  api.onDispose?.(() => clearInterval(sweepTimer));

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
          // At most one task may hold the runner (In Progress or Waiting for an
          // answer). A manual move into a busy In Progress column is refused, so
          // it cannot wedge the runner behind a second "running" task.
          if (status === "in_progress" && current.tasks.some((t: any) => isHeld(t) && t.id !== id)) {
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
          // Leaving the run's own columns ends any recorded run: the task is no
          // longer owned by a chat session. Waiting keeps it — the run is still
          // live, just blocked on an answer. A run that is still going is muted
          // so the sweep does not adopt the card back (see muteRun).
          if (!HELD_STATUSES.has(status)) {
            muteRun(current, task.runSessionId);
            delete task.runSessionId; delete task.runStartedAt;
          }
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
          if (status === "in_progress" && current.tasks.some((t: any) => isHeld(t) && t.id !== id)) {
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
          // Leaving the run's own columns ends any recorded run: the task is no
          // longer owned by a chat session (Waiting keeps it — see `moveTask`).
          // A run that is still going is muted so the sweep does not adopt the
          // card back (see muteRun).
          if (!HELD_STATUSES.has(status)) {
            muteRun(current, task.runSessionId);
            delete task.runSessionId; delete task.runStartedAt;
          }
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
          if (current.tasks.some(isHeld)) { busy = true; return current; }
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
          // The abort takes a moment; mute the run so the sweep does not adopt
          // the card back while pi is still winding down (see muteRun).
          muteRun(current, task.runSessionId);
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
          // A failed dispatch must not be adopted back as a live run (see muteRun).
          muteRun(current, task.runSessionId);
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
          const gone = current.tasks.find((t: any) => t.id === id);
          // A card the orchestrator is working right now: remember the run, or
          // the sweep would simply adopt it straight back (see muteRun).
          if (gone) muteRun(current, gone.runSessionId);
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
    // Both the index (project files) and any pre-move global buckets: reading a
    // legacy bucket migrates it into its project file here.
    const legacy = api.store.get(KEY, {});
    const known = new Set<string>([...knownProjects(), ...Object.keys(legacy && typeof legacy === "object" ? legacy : {})]);
    for (const workspace of known) {
      if (readState(workspace).runnerPaused !== false) continue;
      reconcile(workspace);
      void pump(workspace);
    }
  }
}
