/**
 * git plugin — server half.
 *
 * The Git view's HTTP routes (status, staging, history, branches, remotes,
 * stash, submodules) plus the AI commit-message generator. Extracted from
 * server.ts so the feature owns its server code; git primitives and the
 * settings reader arrive through `api.kit`.
 */

export function activate(api: any): void {
  const {
    fs,
    path,
    jsonResponse,
    requireCwd,
    jsonBody,
    intParam,
    readSettingsJson,
    DEFAULT_COMMIT_TEMPLATE,
    git,
    gitTry,
    gitTryAsync,
    resolveWithinCwd,
    cleanPaths,
    rejectOptionLike,
    parsePorcelainLine,
    porcelainStatus,
    generateCommitMessage,
  } = api.kit;

  api.route("GET", "/git/status", async (ctx) => {
    const url = ctx.url;
    const absCwd = requireCwd(url.searchParams.get("cwd"));
    if (absCwd instanceof Response) return absCwd;
    const isRepo = gitTry(absCwd, ["rev-parse", "--is-inside-work-tree"]);
    if (!isRepo.ok) return jsonResponse({ git: false, error: "not a git repository" });
    const branch = gitTry(absCwd, ["branch", "--show-current"]);
    const head = gitTry(absCwd, ["rev-parse", "--short", "HEAD"]);
    const upstream = gitTry(absCwd, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]);
    let ahead = 0, behind = 0;
    if (upstream.ok && upstream.out.trim()) {
      const ab = gitTry(absCwd, ["rev-list", "--left-right", "--count", `HEAD...${upstream.out.trim()}`]);
      if (ab.ok) {
        const parts = ab.out.trim().split(/\s+/);
        ahead = parseInt(parts[0] ?? "0", 10) || 0;
        behind = parseInt(parts[1] ?? "0", 10) || 0;
      }
    }
    const remotesOut = gitTry(absCwd, ["remote"]);
    const remotes = remotesOut.ok ? remotesOut.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    const porcelain = gitTry(absCwd, ["status", "--porcelain=v1", "-uall"]);
    const files: any[] = [];
    for (const raw of porcelain.out.split("\n")) {
      const e = parsePorcelainLine(raw);
      if (!e) continue;
      if (e.ignored) continue; // ignored files are not part of the Git view
      const { x, y, path: p, renamedFrom: renamed_from } = e;
      const status = e.conflicted ? "conflicted" : porcelainStatus(e);
      if (e.conflicted) { files.push({ path: p, section: "conflicted", status, renamed_from }); continue; }
      if (e.code === "??") { files.push({ path: p, section: "untracked", status, renamed_from }); continue; }
      const staged = x !== " ";
      const unstaged = y !== " ";
      if (staged) files.push({ path: p, section: "staged", status, renamed_from, x, y });
      if (unstaged) files.push({ path: p, section: "unstaged", status, renamed_from, x, y });
    }
    const order: Record<string, number> = { conflicted: 0, staged: 1, unstaged: 2, untracked: 3 };
    files.sort((a, b) => (order[a.section] - order[b.section]) || a.path.localeCompare(b.path));
    return jsonResponse({
      git: true, cwd: absCwd,
      branch: branch.ok && branch.out.trim() ? branch.out.trim() : null,
      detached: !(branch.ok && branch.out.trim()),
      head: head.ok ? head.out.trim() : null,
      upstream: upstream.ok && upstream.out.trim() ? upstream.out.trim() : null,
      ahead, behind, remotes, files,
    });
  });

  api.route("POST", "/git/stage", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    let r;
    if (parsed.all) r = gitTry(absCwd, ["add", "-A"]);
    else {
      const paths = cleanPaths(absCwd, parsed.paths);
      if (!paths || !paths.length) return jsonResponse({ error: "missing paths" }, 400);
      r = gitTry(absCwd, ["add", "--", ...paths]);
    }
    return r.ok ? jsonResponse({ ok: true }) : jsonResponse({ ok: false, error: r.out }, 500);
  });

  api.route("POST", "/git/unstage", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const paths = cleanPaths(absCwd, parsed.paths);
    if (!paths || !paths.length) return jsonResponse({ error: "missing paths" }, 400);
    let r = gitTry(absCwd, ["restore", "--staged", "--", ...paths]);
    if (!r.ok) r = gitTry(absCwd, ["reset", "-q", "HEAD", "--", ...paths]);
    return r.ok ? jsonResponse({ ok: true }) : jsonResponse({ ok: false, error: r.out }, 500);
  });

  api.route("POST", "/git/discard", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const paths = cleanPaths(absCwd, parsed.paths);
    if (!paths || !paths.length) return jsonResponse({ error: "missing paths" }, 400);
    const r = parsed.untracked
      ? gitTry(absCwd, ["clean", "-fd", "--", ...paths])
      : gitTry(absCwd, ["restore", "--", ...paths]);
    return r.ok ? jsonResponse({ ok: true }) : jsonResponse({ ok: false, error: r.out }, 500);
  });

  api.route("POST", "/git/ignore", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const paths = cleanPaths(absCwd, parsed.paths);
    if (!paths || !paths.length) return jsonResponse({ error: "missing paths" }, 400);
    // `.gitignore` is written beside the requested files (i.e. under `cwd`),
    // which keeps it inside the sandbox: git resolves the patterns relative to
    // the ignore file, and the Git view's paths are relative to `cwd` too.
    const ignorePath = path.join(absCwd, ".gitignore");
    const pattern = (p: string) => {
      // Escape backslashes first, then escape a leading `#`/`!` (comment / negation)
      // and trailing spaces so the literal filename is ignored rather than read as
      // gitignore syntax.
      let s = p.replace(/\\/g, "\\\\");
      if (s.startsWith("#") || s.startsWith("!")) s = "\\" + s;
      s = s.replace(/ +$/, (m) => m.replace(/ /g, "\\ "));
      return s;
    };
    let text = "";
    try { text = fs.readFileSync(ignorePath, "utf8"); } catch {}
    const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
    const added = paths.filter((p) => !lines.has(pattern(p)) && !lines.has(p));
    if (added.length) {
      let out = text;
      if (out && !out.endsWith("\n")) out += "\n";
      out += added.map(pattern).join("\n") + "\n";
      try { fs.writeFileSync(ignorePath, out); }
      catch (e) { return jsonResponse({ ok: false, error: String(e) }, 500); }
    }
    return jsonResponse({ ok: true, added });
  });

  api.route("GET", "/git/diff", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    const file = url.searchParams.get("file") ?? "";
    const cached = url.searchParams.get("cached") === "1";
    if (!cwd || !file) return jsonResponse({ error: "missing cwd or file" }, 400);
    const absCwd = requireCwd(cwd);
    if (absCwd instanceof Response) return absCwd;
    if (!resolveWithinCwd(absCwd, file)) return jsonResponse({ error: "invalid file path" }, 400);
    if (cached) {
      const d = gitTry(absCwd, ["diff", "--cached", "--no-color", "--unified=3", "--", file]);
      return jsonResponse({ cwd: absCwd, file, cached: true, untracked: false, diff: d.out });
    }
    const d = gitTry(absCwd, ["diff", "--no-color", "--unified=3", "--", file]);
    if (!d.out.trim()) {
      const tracked = gitTry(absCwd, ["ls-files", "--error-unmatch", "--", file]);
      if (!tracked.ok) {
        // `--no-index` needs an empty side to diff against: /dev/null on POSIX,
        // NUL on Windows (git.exe there does not know /dev/null).
        const empty = process.platform === "win32" ? "NUL" : "/dev/null";
        const ni = gitTry(absCwd, ["diff", "--no-index", "--no-color", "--unified=3", "--", empty, file]);
        return jsonResponse({ cwd: absCwd, file, cached: false, untracked: true, diff: ni.out });
      }
    }
    return jsonResponse({ cwd: absCwd, file, cached: false, untracked: false, diff: d.out });
  });

  api.route("GET", "/git/log", async (ctx) => {
    const url = ctx.url;
    const absCwd = requireCwd(url.searchParams.get("cwd"));
    if (absCwd instanceof Response) return absCwd;
    const all = url.searchParams.get("all") === "1";
    const limit = intParam(url, "limit", 200, 500);
    // `%P` yields space-separated parent SHAs (first parent first) so the UI
    // can draw a coloured lane graph. --topo-order keeps the first-parent
    // (mainline) chain grouped; the lanes are rebuilt client-side from the
    // parent lists, so we skip git's (expensive) `--graph` output entirely.
    const fmt = "%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D%x1f%P";
    const r = gitTry(absCwd, ["log", "--topo-order", "--date=iso-strict", `--format=${fmt}`, "-n", String(limit), ...(all ? ["--all"] : [])]);
    if (!r.ok) return jsonResponse({ ok: false, error: r.out }, 500);
    const commits: any[] = [];
    for (const line of r.out.split("\n")) {
      if (line.length === 0) continue;
      const f = line.split("\x1f");
      commits.push({
        sha: f[0] ?? "", short: f[1] ?? "", author: f[2] ?? "",
        date: f[3] ?? "", subject: f[4] ?? "", refs: (f[5] ?? "").trim(),
        parents: (f[6] ?? "").split(" ").map((s: string) => s.trim()).filter(Boolean),
      });
    }
    return jsonResponse({ ok: true, commits });
  });

  api.route("GET", "/git/show", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    const sha = url.searchParams.get("sha") ?? "";
    if (!cwd || !sha) return jsonResponse({ error: "missing cwd or sha" }, 400);
    // `sha` becomes a git argument — a leading dash would be read as an option.
    if (rejectOptionLike(sha)) return jsonResponse({ error: "invalid sha" }, 400);
    const absCwd = requireCwd(cwd);
    if (absCwd instanceof Response) return absCwd;
    const meta = gitTry(absCwd, ["show", "-s", "--date=iso-strict", "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f%cn%x1f%ce%x1f%cd%x1f%P", sha]);
    const diff = gitTry(absCwd, ["show", "--no-color", "--unified=3", "--format=", sha]);
    const names = gitTry(absCwd, ["show", "--name-only", "--format=", sha]);
    const f = meta.out.split("\x1f");
    return jsonResponse({
      ok: meta.ok,
      sha: f[0] ?? sha, author: f[1] ?? "", email: f[2] ?? "",
      date: f[3] ?? "", subject: f[4] ?? "", body: (f[5] ?? "").trim(),
      committer: f[6] ?? "", committerEmail: f[7] ?? "", committerDate: f[8] ?? "",
      parents: (f[9] ?? "").split(" ").map((s: string) => s.trim()).filter(Boolean),
      files: names.out.split("\n").map((s) => s.trim()).filter(Boolean),
      diff: diff.out,
    });
  });

  api.route("GET", "/git/compare", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    let sha1 = url.searchParams.get("sha1") ?? "";
    let sha2 = url.searchParams.get("sha2") ?? "";
    if (!cwd || !sha1) return jsonResponse({ error: "missing cwd or sha1" }, 400);
    if (sha1.startsWith("-") || sha2.startsWith("-")) return jsonResponse({ error: "invalid sha" }, 400);
    const absCwd = requireCwd(cwd);
    if (absCwd instanceof Response) return absCwd;
    const args = ["diff", "--no-color", "--unified=3", sha1];
    if (sha2) args.push(sha2);
    const diff = gitTry(absCwd, args);
    const statArgs = ["diff", "--stat", sha1];
    if (sha2) statArgs.push(sha2);
    const stat = gitTry(absCwd, statArgs);
    return jsonResponse({
      ok: diff.ok,
      diff: diff.out,
      stat: stat.out.split("\n").filter(Boolean).pop() || "",
      sha1, sha2: sha2 || "WORKTREE",
    });
  });

  api.route("GET", "/git/cat", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    const sha = url.searchParams.get("sha") ?? "";
    const fp = url.searchParams.get("path") ?? "";
    if (!cwd || !sha || !fp) return jsonResponse({ error: "missing cwd, sha, or path" }, 400);
    if (sha.startsWith("-") || fp.startsWith("-")) return jsonResponse({ error: "invalid sha or path" }, 400);
    const absCwd = requireCwd(cwd);
    if (absCwd instanceof Response) return absCwd;
    const r = gitTry(absCwd, ["show", `${sha}:${fp}`]);
    if (!r.ok) return jsonResponse({ ok: false, error: r.out || "file not found or binary" }, 404);
    // Refuse binary content (null bytes in first 8KB)
    if (r.out.includes("\u0000")) return jsonResponse({ ok: false, error: "binary file — cannot display" }, 415);
    return jsonResponse({ ok: true, content: r.out, path: fp, sha });
  });

  api.route("POST", "/git/action", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const action = typeof parsed.action === "string" ? parsed.action : "";
    const sha = typeof parsed.sha === "string" ? parsed.sha.trim() : "";
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    // `sha`/`name` become git arguments, so a leading dash would be read as an
    // option of the command being run (e.g. name "-d" turns `git tag <name>`
    // into a tag deletion). Same guard /git/compare and /git/cat already use.
    if (rejectOptionLike(sha, name)) return jsonResponse({ error: "invalid sha or name" }, 400);
    let r: { ok: boolean; out: string };
    switch (action) {
      case "checkout":
        if (!sha) return jsonResponse({ error: "missing sha" }, 400);
        r = gitTry(absCwd, ["checkout", "--detach", sha]);
        break;
      case "cherry-pick":
        if (!sha) return jsonResponse({ error: "missing sha" }, 400);
        r = gitTry(absCwd, ["cherry-pick", "--no-edit", sha]);
        break;
      case "revert":
        if (!sha) return jsonResponse({ error: "missing sha" }, 400);
        r = gitTry(absCwd, ["revert", "--no-edit", sha]);
        break;
      case "rebase":
        if (!sha) return jsonResponse({ error: "missing sha" }, 400);
        r = gitTry(absCwd, ["rebase", sha]);
        break;
      case "reset":
        if (!sha) return jsonResponse({ error: "missing sha" }, 400);
        r = gitTry(absCwd, ["reset", "--mixed", sha]);
        break;
      case "branch":
        if (!name || !sha) return jsonResponse({ error: "missing name or sha" }, 400);
        r = gitTry(absCwd, ["checkout", "-b", name, sha]);
        break;
      case "tag":
        if (!name || !sha) return jsonResponse({ error: "missing name or sha" }, 400);
        r = gitTry(absCwd, ["tag", name, sha]);
        break;
      default:
        return jsonResponse({ error: "unknown action" }, 400);
    }
    if (!r.ok) {
      // Rebase/cherry-pick/etc. conflicts leave the repo mid-operation; flag it
      // so the UI can surface the conflicted files and a clearer message.
      const conflict = /\bconflict\b|would be overwritten|CONFLICT/i.test(r.out);
      return jsonResponse({ ok: false, error: r.out, conflict }, 409);
    }
    return jsonResponse({ ok: true, out: r.out.trim() });
  });

  api.route("POST", "/git/commit", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    if (!message) return jsonResponse({ error: "missing commit message" }, 400);
    const amend = parsed.amend === true;
    // Fall back to a Pi Scope identity when the repo has none configured, so
    // the GUI can still commit without failing on "who are you".
    const cfg: Record<string, string> = {};
    const uname = gitTry(absCwd, ["config", "user.name"]);
    const uemail = gitTry(absCwd, ["config", "user.email"]);
    if (!uname.ok || !uname.out.trim()) cfg["user.name"] = "Pi Scope";
    if (!uemail.ok || !uemail.out.trim()) cfg["user.email"] = "scope@localhost";
    const r = gitTry(absCwd, ["commit", ...(amend ? ["--amend"] : []), "-m", message], cfg);
    if (!r.ok) return jsonResponse({ ok: false, error: r.out }, 409);
    // The commit consumed the repo's drafted message: drop the job so a page
    // that comes back later never adopts a draft the box has moved past.
    dropCommitJob(absCwd);
    const sha = gitTry(absCwd, ["rev-parse", "--short", "HEAD"]);
    return jsonResponse({ ok: true, sha: sha.out.trim(), amend });
  });

  // ─── AI commit-message draft: a job per repo, outliving the request ──────
  // Drafting is slow (a model round-trip) and the page is not: the Chat nav
  // reloads the document, and any reload used to lose the answer forever — the
  // response had nowhere to go while `pi` kept working. So the draft runs as a
  // server-side job keyed by repo, and the Git view re-reads it (GET below)
  // whenever it is shown, adopting a running or finished job. That also makes
  // the button idempotent: a second click while one draft is in flight reuses
  // the running `pi` instead of spawning another.
  const JOB_TTL_MS = 30 * 60_000; // how long a finished draft stays adoptable
  const JOB_MAX = 32; // repos remembered at once (one job each)
  type CommitJob = {
    id: string;
    cwd: string;
    model: string;
    source: string;
    status: "running" | "done" | "error";
    message: string;
    error: string;
    startedAt: number;
    finishedAt: number;
    /** Settles (never rejects) when the draft reaches a terminal state. */
    done: Promise<void>;
  };
  const commitJobs = new Map<string, CommitJob>();
  let commitJobSeq = 0;

  /** Forget a repo's draft job (its commit consumed it). */
  function dropCommitJob(absCwd: string): void {
    commitJobs.delete(absCwd);
  }

  /** Drop finished drafts past their TTL, and never grow past JOB_MAX repos. */
  function pruneCommitJobs(): void {
    const now = Date.now();
    for (const [key, job] of commitJobs) {
      if (now - (job.finishedAt || job.startedAt) > JOB_TTL_MS) commitJobs.delete(key);
    }
    while (commitJobs.size > JOB_MAX) {
      let oldestKey = "";
      let oldest = Infinity;
      for (const [key, job] of commitJobs) {
        const t = job.finishedAt || job.startedAt;
        if (t < oldest) { oldest = t; oldestKey = key; }
      }
      commitJobs.delete(oldestKey);
    }
  }

  /**
   * Render the draft prompt for a repo, or return the Response to fail with.
   * Kept separate from the job so the request still answers 400/409 (nothing to
   * describe, diff failure) before anything is spawned.
   *
   * The change itself is never sent: the model is handed the changed paths and
   * inspects them itself (`pi --print` runs in the repo with its read/bash
   * tools), which keeps the prompt small — no clipped diff, no argv size risk —
   * and bases the message on the real code rather than a truncated hunk. A
   * custom template that still references `{{diff}}` keeps the old behaviour.
   *
   * Only the index is described: the message must match the commit that would
   * actually be made, so unstaged worktree changes are ignored rather than
   * drafted into it. A commit with nothing staged has nothing to describe.
   */
  function buildCommitPrompt(absCwd: string): { prompt: string; model: string; source: string } | Response {
    // `--name-status` gives the model each staged path with the status that
    // changed it (A/M/D/R), which is all it needs to go and look.
    const listed = gitTry(absCwd, ["diff", "--cached", "--name-status"]);
    if (!listed.ok) return jsonResponse({ error: listed.out || "git diff failed" }, 409);
    const files = listed.out.trim();
    if (!files) return jsonResponse({ error: "nothing staged to describe — stage your changes first" }, 400);
    const source = "staged";

    const branch = gitTry(absCwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
    // The commit-message model/template are this feature's own settings, kept in
    // the plugin's own store (`<plugins dir>/.data/git.json` — the same file the
    // settings writers in server.ts write); only the default-model fallback comes
    // from pi's settings.json.
    const setting = (key: string) => {
      const v = api.store.get(key);
      return typeof v === "string" ? v.trim() : "";
    };
    const settings = readSettingsJson();
    const configured = setting("commitModel");
    const model = configured || String(settings.defaultModel || "").trim() || "google/gemini-2.5-flash-lite";

    // The user's instruction template (Settings → Plugins → Git), with placeholders
    // substituted. An empty setting means the built-in default.
    const templateCfg = setting("commitTemplate");
    const template = templateCfg || DEFAULT_COMMIT_TEMPLATE;
    const usesDiffSlot = /\{\{\s*diff\s*\}\}/.test(template);
    const usesChangeSlot = /\{\{\s*(?:files|diff)\s*\}\}/.test(template);
    // Legacy path only: a template that still asks for `{{diff}}` gets it, capped
    // so argv stays a sane size. The default template asks for the paths instead.
    const MAX_DIFF = 12_000;
    let clipped = "";
    if (usesDiffSlot) {
      const diff = gitTry(absCwd, ["diff", "--cached", "--no-color", "--unified=3"]);
      const diffText = diff.ok ? diff.out.trim() : "";
      clipped = diffText.length > MAX_DIFF
        ? `${diffText.slice(0, MAX_DIFF)}\n\n… (diff truncated; ${diffText.length - MAX_DIFF} more characters)`
        : diffText;
    }
    const rendered = template
      .replace(/\{\{\s*branch\s*\}\}/g, branch || "(detached)")
      .replace(/\{\{\s*source\s*\}\}/g, source)
      .replace(/\{\{\s*files\s*\}\}/g, files || "(none listed)")
      .replace(/\{\{\s*diff\s*\}\}/g, clipped);
    // A template that never references the change still needs it, otherwise the
    // model has nothing to describe — append the changed paths.
    const prompt = usesChangeSlot
      ? rendered
      : `${rendered}\n\nBranch: ${branch || "(detached)"}\nStaged files (${source}):\n${files}`;

    return { prompt, model, source };
  }

  /** Start the repo's draft — or hand back the run already in flight. */
  function startCommitJob(
    absCwd: string,
    built: { prompt: string; model: string; source: string },
  ): CommitJob {
    const running = commitJobs.get(absCwd);
    if (running && running.status === "running") return running;

    const job: CommitJob = {
      id: `j${++commitJobSeq}-${Date.now().toString(36)}`,
      cwd: absCwd,
      model: built.model,
      source: built.source,
      status: "running",
      message: "",
      error: "",
      startedAt: Date.now(),
      finishedAt: 0,
      done: Promise.resolve(),
    };
    commitJobs.set(absCwd, job);
    pruneCommitJobs();

    // The job owns the outcome, the request only waits for it: `done` resolves
    // on success AND on failure (the reason lands in `job.error`), so a waiter
    // never needs its own try/catch and can never reject into the HTTP layer.
    job.done = (async () => {
      try {
        const message = await generateCommitMessage({ cwd: absCwd, model: job.model, prompt: built.prompt });
        if (message) job.message = message;
        else { job.status = "error"; job.error = "the model returned an empty message"; }
      } catch (err: any) {
        job.status = "error";
        job.error = `could not generate a commit message: ${String(err?.message ?? err)}`;
      } finally {
        if (job.status === "running") job.status = "done";
        job.finishedAt = Date.now();
      }
    })();
    return job;
  }

  api.route("POST", "/git/commit-message", async (ctx) => {
    const body = await gitPost(ctx.req);
    if (body instanceof Response) return body;
    const { cwd: absCwd } = body;

    const built = buildCommitPrompt(absCwd);
    if (built instanceof Response) return built;

    const job = startCommitJob(absCwd, built);
    await job.done;
    // The registry is the source of truth: a job that is gone was consumed (a
    // commit landed while this draft was still running), so its message no
    // longer describes the box the user is looking at.
    if (commitJobs.get(absCwd) !== job) {
      return jsonResponse({ ok: false, error: "the commit changed while the message was being drafted — generate again" }, 409);
    }
    if (job.status === "error") return jsonResponse({ error: job.error }, 502);
    return jsonResponse({ ok: true, message: job.message, model: job.model, source: job.source, job: job.id });
  });

  // What is this repo's draft doing? The Git view asks on every show — that is
  // how a generation started before a page reload is recovered instead of lost.
  api.route("GET", "/git/commit-message", async (ctx) => {
    const absCwd = requireCwd(ctx.url.searchParams.get("cwd"));
    if (absCwd instanceof Response) return absCwd;
    pruneCommitJobs();
    const job = commitJobs.get(absCwd);
    if (!job) return jsonResponse({ ok: true, status: "idle" });
    return jsonResponse({
      ok: true,
      status: job.status,
      job: job.id,
      cwd: job.cwd,
      model: job.model,
      source: job.source,
      message: job.message,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  });

  api.route("POST", "/git/branch", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const action = parsed.action ?? "";
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) return jsonResponse({ error: "missing branch name" }, 400);
    const startPoint = typeof parsed.startPoint === "string" && parsed.startPoint.trim() ? parsed.startPoint.trim() : "";
    if (rejectOptionLike(name, startPoint)) return jsonResponse({ error: "invalid branch name" }, 400);
    let r;
    if (action === "create") {
      r = gitTry(absCwd, ["switch", "-c", name, ...(startPoint ? [startPoint] : [])]);
    } else if (action === "delete") {
      r = gitTry(absCwd, ["branch", "-D", name]);
    } else if (action === "checkout-remote") {
      // `name` is a remote-tracking ref ("origin/feature"). Check out a local
      // branch that tracks it — reusing an existing local branch of the same
      // short name when there is one, otherwise creating it with --track.
      const slash = name.indexOf("/");
      const local = slash >= 0 ? name.slice(slash + 1) : name;
      if (!local) return jsonResponse({ error: "missing branch name" }, 400);
      // Both `name` (the --track ref) and the derived `local` become git
      // arguments, so a leading dash must never reach them.
      if (rejectOptionLike(name, local)) return jsonResponse({ error: "invalid branch name" }, 400);
      const exists = gitTry(absCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${local}`]);
      r = exists.ok
        ? gitTry(absCwd, ["switch", local])
        : gitTry(absCwd, ["switch", "-c", local, "--track", name]);
    } else {
      r = gitTry(absCwd, ["switch", name]);
    }
    return r.ok ? jsonResponse({ ok: true, out: r.out.trim() }) : jsonResponse({ ok: false, error: r.out }, 409);
  });

  api.route("GET", "/git/branches", async (ctx) => {
    const url = ctx.url;
    const absCwd = requireCwd(url.searchParams.get("cwd"));
    if (absCwd instanceof Response) return absCwd;
    const cur = gitTry(absCwd, ["branch", "--show-current"]);
    // for-each-ref expands %00 (NUL) but not %x1f, so use NUL separators.
    const r = gitTry(absCwd, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname:short)%00%(upstream:lstrip=2)%00%(creatordate:relative)", "--sort=-committerdate", "refs/heads"]);
    const branches: any[] = [];
    for (const line of r.out.split("\n")) {
      if (!line.trim()) continue;
      const [name, sha, upstream, date] = line.split("\0");
      branches.push({ name: name ?? "", sha: sha ?? "", upstream: upstream ?? "", date: date ?? "" });
    }
    // Remote-tracking branches (refs/remotes/<remote>/<branch>), listed alongside
    // the local ones so the Branches view mirrors `git branch -a`. Each remote's
    // symbolic HEAD alias (e.g. origin/HEAD → origin/main) is skipped — it points
    // at another branch rather than being one.
    const rr = gitTry(absCwd, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname:short)%00%(creatordate:relative)", "--sort=-committerdate", "refs/remotes"]);
    const remoteBranches: any[] = [];
    for (const line of rr.out.split("\n")) {
      if (!line.trim()) continue;
      const [ref, sha, date] = line.split("\0");
      const slash = (ref ?? "").indexOf("/");
      if (slash <= 0) continue;
      const remote = ref.slice(0, slash);
      const short = ref.slice(slash + 1);
      if (!short || short === "HEAD") continue;
      remoteBranches.push({ name: ref, remote, short, sha: sha ?? "", date: date ?? "" });
    }
    return jsonResponse({ ok: true, current: cur.ok ? cur.out.trim() : null, branches, remoteBranches });
  });

  api.route("GET", "/git/remotes", async (ctx) => {
    const url = ctx.url;
    const absCwd = requireCwd(url.searchParams.get("cwd"));
    if (absCwd instanceof Response) return absCwd;
    const r = gitTry(absCwd, ["remote", "-v"]);
    const map = new Map<string, { name: string; fetch: string; push: string }>();
    for (const line of r.out.split("\n")) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!m) continue;
      const entry = map.get(m[1]) ?? { name: m[1], fetch: "", push: "" };
      if (m[3] === "fetch") entry.fetch = m[2]; else entry.push = m[2];
      map.set(m[1], entry);
    }
    return jsonResponse({ ok: true, remotes: Array.from(map.values()) });
  });

  api.route("POST", "/git/remote", async (ctx) => {
    const url = ctx.url;
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const urlStr = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (!name) return jsonResponse({ error: "missing remote name" }, 400);
    if (rejectOptionLike(name, urlStr)) return jsonResponse({ error: "invalid remote name or url" }, 400);
    let r;
    if (parsed.action === "remove") r = gitTry(absCwd, ["remote", "remove", name]);
    else {
      if (!urlStr) return jsonResponse({ error: "missing remote url" }, 400);
      r = gitTry(absCwd, ["remote", "add", name, urlStr]);
    }
    return r.ok ? jsonResponse({ ok: true }) : jsonResponse({ ok: false, error: r.out }, 409);
  });

  const pushPullFetch = async (ctx) => {
    const pathname = ctx.url.pathname;
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    let remote = typeof parsed.remote === "string" && parsed.remote.trim() ? parsed.remote.trim() : "";
    let branch = typeof parsed.branch === "string" && parsed.branch.trim() ? parsed.branch.trim() : "";
    // Both become git arguments, so a leading dash would be read as an option
    // of push/pull/fetch (e.g. remote "--force" or branch "--tags").
    if (rejectOptionLike(remote, branch)) return jsonResponse({ error: "invalid remote or branch" }, 400);
    // Resolve the current branch name when the client doesn't send one.
    if (!branch) {
      const cur = gitTry(absCwd, ["branch", "--show-current"]);
      if (cur.ok && cur.out.trim()) branch = cur.out.trim();
    }
    // These three hit the network: a push/pull/fetch against a remote can take
    // seconds (auth, a large fetch) and used to freeze the whole server — SSE,
    // the terminal socket, every other request — because gitTry is synchronous.
    // The local plumbing above (branch/rev-parse/remote) stays sync, and a
    // credential prompt is still disabled so nothing can hang on stdin.
    let r;
    if (pathname === "/git/push") {
      // When no remote/branch are specified and the branch lacks an upstream,
      // git push fails with "no upstream branch". Auto-set upstream on origin.
      if (!remote && branch) {
        const up = gitTry(absCwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
        if (!up.ok || !up.out.trim()) {
          // No upstream configured — find the default remote and push with --set-upstream.
          const remotes = gitTry(absCwd, ["remote"]);
          const defaultRemote = remotes.ok ? remotes.out.split("\n")[0]?.trim() || "origin" : "origin";
          r = await gitTryAsync(absCwd, ["push", "--set-upstream", defaultRemote, branch]);
        } else {
          r = await gitTryAsync(absCwd, ["push"]);
        }
      } else {
        r = await gitTryAsync(absCwd, ["push", ...(remote ? [remote, branch || "HEAD"] : [])]);
      }
    } else if (pathname === "/git/pull") {
      r = await gitTryAsync(absCwd, ["pull", ...(remote ? [remote, branch] : [])]);
    } else {
      r = await gitTryAsync(absCwd, ["fetch", ...(remote ? [remote] : ["--all"])]);
    }
    return r.ok ? jsonResponse({ ok: true, out: r.out.trim() }) : jsonResponse({ ok: false, error: r.out }, 409);
  };
  api.route("POST", "/git/push", pushPullFetch);
  api.route("POST", "/git/pull", pushPullFetch);
  api.route("POST", "/git/fetch", pushPullFetch);

  api.route("GET", "/git/stash", async (ctx) => {
    const url = ctx.url;
    const absCwd = requireCwd(url.searchParams.get("cwd"));
    if (absCwd instanceof Response) return absCwd;
    // No --date here: it turns %gd's selector into a date-based form instead
    // of the stable stash@{0} handle used by pop/drop. %ad stays human-readable.
    const r = gitTry(absCwd, ["stash", "list", "--format=%gd%x1f%H%x1f%ad%x1f%s"]);
    const items: any[] = [];
    for (const line of r.out.split("\n")) {
      if (!line.trim()) continue;
      const [ref, sha, date, subject] = line.split("\x1f");
      items.push({ ref: ref ?? "", sha: sha ?? "", date: date ?? "", subject: subject ?? "" });
    }
    return jsonResponse({ ok: true, items });
  });

  api.route("POST", "/git/stash", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const action = parsed.action ?? "";
    const ref = typeof parsed.ref === "string" && parsed.ref.trim() ? parsed.ref.trim() : "";
    // "stash@{0}" is the expected form; anything else (e.g. "--all") would be
    // read as an option of `git stash pop`/`drop`.
    if (ref && !/^stash@\{\d+\}$/.test(ref)) return jsonResponse({ error: "invalid stash ref" }, 400);
    let r;
    if (action === "pop") r = gitTry(absCwd, ["stash", "pop", ...(ref ? [ref] : [])]);
    else if (action === "drop") r = gitTry(absCwd, ["stash", "drop", ...(ref ? [ref] : [])]);
    else {
      const message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : "";
      r = gitTry(absCwd, ["stash", "push", "-u", ...(message ? ["-m", message] : [])]);
    }
    return r.ok ? jsonResponse({ ok: true, out: r.out.trim() }) : jsonResponse({ ok: false, error: r.out }, 409);
  });

  api.route("GET", "/git/submodules", async (ctx) => {
    const url = ctx.url;
    const absCwd = requireCwd(url.searchParams.get("cwd"));
    if (absCwd instanceof Response) return absCwd;
    const r = gitTry(absCwd, ["submodule", "status", "--recursive"]);
    // Not a failure if there are no submodules or no .gitmodules
    const items: any[] = [];
    const urls: Record<string, string> = {};
    const cfgR = gitTry(absCwd, ["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.url"]);
    if (cfgR.ok) {
      for (const line of cfgR.out.split("\n")) {
        const m = line.match(/^submodule\.(.+)\.url\s+(.+)$/);
        if (m) urls[m[1]] = m[2];
      }
    }
    if (r.ok) {
      for (const line of r.out.split("\n")) {
        if (!line.trim()) continue;
        // Format: [ ][-|+|U]sha path (ref)
        const m = line.match(/^[ ]?([-+U ]?)([0-9a-f]{40})\s+(.+?)(?:\s+\((.+)\))?$/);
        if (!m) continue;
        const flag = m[1].trim();
        const sha = m[2];
        const subPath = m[3];
        const ref = m[4] || "";
        let status = "ok";
        if (flag === "-") status = "uninitialized";
        else if (flag === "+") status = "dirty";
        else if (flag === "U") status = "merge-conflict";
        items.push({ path: subPath, sha, ref, status, url: urls[subPath] || "" });
      }
    }
    // Include submodules from .gitmodules that may not be in the working tree yet
    for (const [p, u] of Object.entries(urls)) {
      if (!items.some((it) => it.path === p)) {
        items.push({ path: p, sha: "", ref: "", status: "uninitialized", url: u });
      }
    }
    return jsonResponse({ ok: true, items });
  });

  api.route("POST", "/git/submodule", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd, parsed } = body;
    const action = parsed.action ?? "";
    const subPath = typeof parsed.path === "string" ? parsed.path.trim() : "";
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    // Validate submodule path to prevent traversal outside the repo
    if (subPath && !resolveWithinCwd(absCwd, subPath)) return jsonResponse({ error: "invalid submodule path" }, 400);
    // A path/url starting with "-" would be parsed as a git option.
    if (rejectOptionLike(subPath, url)) return jsonResponse({ error: "invalid submodule path or url" }, 400);
    let r: { ok: boolean; out: string };
    switch (action) {
      case "add":
        if (!url || !subPath) return jsonResponse({ error: "missing url or path" }, 400);
        // Clones the submodule — network, so it must not block the event loop.
        r = await gitTryAsync(absCwd, ["submodule", "add", url, subPath]);
        break;
      case "remove":
        if (!subPath) return jsonResponse({ error: "missing path" }, 400);
        r = gitTry(absCwd, ["submodule", "deinit", "-f", "--", subPath]);
        if (r.ok) {
          gitTry(absCwd, ["rm", "-f", "--", subPath]);
          const modPath = path.join(absCwd, ".git", "modules", subPath);
          try { fs.rmSync(modPath, { recursive: true, force: true }); } catch {}
        }
        break;
      case "update":
        // Fetches every missing submodule — network (see `add`).
        r = await gitTryAsync(absCwd, ["submodule", "update", "--init", "--recursive", ...(subPath ? ["--", subPath] : [])]);
        break;
      case "init":
        r = gitTry(absCwd, ["submodule", "init", ...(subPath ? [subPath] : [])]);
        break;
      case "deinit":
        if (!subPath) return jsonResponse({ error: "missing path" }, 400);
        r = gitTry(absCwd, ["submodule", "deinit", "-f", "--", subPath]);
        break;
      case "sync":
        r = gitTry(absCwd, ["submodule", "sync", ...(subPath ? ["--", subPath] : [])]);
        break;
      default:
        return jsonResponse({ error: "unknown action" }, 400);
    }
    return r.ok ? jsonResponse({ ok: true, out: r.out.trim() }) : jsonResponse({ ok: false, error: r.out }, 409);
  });

  async function gitPost(req: Request): Promise<{ cwd: string; parsed: any } | Response> {
    const { value: parsed, error } = await jsonBody(req);
    if (error) return error;
    const absCwd = requireCwd(parsed?.cwd);
    if (absCwd instanceof Response) return absCwd;
    return { cwd: absCwd, parsed };
  }
}
