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
 * Actions: `setOfficeName`, `addTask`, `moveTask`, `removeTask`,
 * `setRunnerPaused`. Validation is unchanged from the core handlers (collapsed
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
    for (const k of ["createdAt", "plannedAt", "startedAt", "finishedAt"]) {
      const v = Number(r[k]);
      if (Number.isFinite(v) && v > 0) task[k] = v;
    }
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

  function commit(workspace: string, mutate: (state: any) => any): any {
    const all = readAll();
    const next = mutate(readState(workspace));
    all[workspace] = next;
    api.store.set(KEY, all);
    return normaliseState(next);
  }

  api.route("GET", "/office", (ctx) => readState(workspaceOf(ctx.url.searchParams.get("cwd"))));

  api.route("POST", "/office", async (ctx) => {
    let body: any;
    try { body = JSON.parse(await readBody(ctx.req)); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const workspace = workspaceOf(body?.cwd);
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
        const state = commit(workspace, (current) => {
          const task = current.tasks.find((t: any) => t.id === id);
          if (!task) return current;
          found = true;
          const at = Date.now();
          task.status = status;
          // Stamp the column the task entered: Planned is worked FIFO by
          // plannedAt, and the timestamps drive the board's own labels.
          if (status === "planned") task.plannedAt = task.plannedAt || at;
          if (status === "todo") { delete task.plannedAt; delete task.startedAt; delete task.finishedAt; }
          if (status === "in_progress") task.startedAt = task.startedAt || at;
          if (status === "done") task.finishedAt = at;
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
        return jsonResponse(commit(workspace, (current) => {
          current.runnerPaused = paused;
          return current;
        }));
      }
      default:
        return jsonResponse({ error: `unknown action: ${action}` }, 400);
    }
  });
}
