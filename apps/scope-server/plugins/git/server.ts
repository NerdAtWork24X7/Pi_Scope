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
    readBody,
    intParam,
    validateCwd,
    readSettingsJson,
    DEFAULT_COMMIT_TEMPLATE,
    git,
    gitTry,
    resolveWithinCwd,
    cleanPaths,
    rejectOptionLike,
    parsePorcelainLine,
    porcelainStatus,
    generateCommitMessage,
  } = api.kit;

  api.route("GET", "/git/status", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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

  api.route("GET", "/git/diff", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    const file = url.searchParams.get("file") ?? "";
    const cached = url.searchParams.get("cached") === "1";
    if (!cwd || !file) return jsonResponse({ error: "missing cwd or file" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    if (!resolveWithinCwd(absCwd, file)) return jsonResponse({ error: "invalid file path" }, 400);
    if (cached) {
      const d = gitTry(absCwd, ["diff", "--cached", "--no-color", "--unified=3", "--", file]);
      return jsonResponse({ cwd: absCwd, file, cached: true, untracked: false, diff: d.out });
    }
    const d = gitTry(absCwd, ["diff", "--no-color", "--unified=3", "--", file]);
    if (!d.out.trim()) {
      const tracked = gitTry(absCwd, ["ls-files", "--error-unmatch", "--", file]);
      if (!tracked.ok) {
        const ni = gitTry(absCwd, ["diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", file]);
        return jsonResponse({ cwd: absCwd, file, cached: false, untracked: true, diff: ni.out });
      }
    }
    return jsonResponse({ cwd: absCwd, file, cached: false, untracked: false, diff: d.out });
  });

  api.route("GET", "/git/log", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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
    const sha = gitTry(absCwd, ["rev-parse", "--short", "HEAD"]);
    return jsonResponse({ ok: true, sha: sha.out.trim(), amend });
  });

  api.route("POST", "/git/commit-message", async (ctx) => {
    const req = ctx.req;
    const body = await gitPost(req);
    if (body instanceof Response) return body;
    const { cwd: absCwd } = body;

    // Prefer the index (what a commit would actually contain); fall back to the
    // worktree so the button still helps before anything is staged.
    let diff = gitTry(absCwd, ["diff", "--cached", "--no-color", "--unified=3"]);
    let source = "staged";
    if (!diff.ok || !diff.out.trim()) {
      diff = gitTry(absCwd, ["diff", "--no-color", "--unified=3"]);
      source = "working tree";
    }
    if (!diff.ok) return jsonResponse({ error: diff.out || "git diff failed" }, 409);
    const diffText = diff.out.trim();
    if (!diffText) return jsonResponse({ error: "nothing to describe — no staged or unstaged changes" }, 400);

    // Keep the prompt bounded: a commit message only needs the shape of the
    // change, and argv has a hard size limit on every platform.
    const MAX_DIFF = 12_000;
    const clipped = diffText.length > MAX_DIFF
      ? `${diffText.slice(0, MAX_DIFF)}\n\n… (diff truncated; ${diffText.length - MAX_DIFF} more characters)`
      : diffText;

    const branch = gitTry(absCwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
    const files = gitTry(absCwd, ["diff", ...(source === "staged" ? ["--cached"] : []), "--name-only"]).out.trim();
    const settings = readSettingsJson();
    const configured = typeof settings.gitCommitModel === "string" ? settings.gitCommitModel.trim() : "";
    const model = configured || String(settings.defaultModel || "").trim() || "google/gemini-2.5-flash-lite";

    // The user's instruction template (Settings → Models), with placeholders
    // substituted. An empty setting means the built-in default.
    const templateCfg = typeof settings.gitCommitTemplate === "string" ? settings.gitCommitTemplate.trim() : "";
    const template = templateCfg || DEFAULT_COMMIT_TEMPLATE;
    const usesDiffSlot = /\{\{\s*diff\s*\}\}/.test(template);
    const rendered = template
      .replace(/\{\{\s*branch\s*\}\}/g, branch || "(detached)")
      .replace(/\{\{\s*source\s*\}\}/g, source)
      .replace(/\{\{\s*files\s*\}\}/g, files || "(none listed)")
      .replace(/\{\{\s*diff\s*\}\}/g, clipped);
    // A template that never references {{diff}} still needs the change itself,
    // otherwise the model has nothing to describe — append it.
    const prompt = usesDiffSlot
      ? rendered
      : `${rendered}\n\nBranch: ${branch || "(detached)"}\nChanges (${source}):\n${clipped}`;

    try {
      const message = await generateCommitMessage({ cwd: absCwd, model, prompt });
      if (!message) return jsonResponse({ error: "the model returned an empty message" }, 502);
      return jsonResponse({ ok: true, message, model, source });
    } catch (err: any) {
      return jsonResponse({ error: `could not generate a commit message: ${String(err?.message ?? err)}` }, 502);
    }
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
    } else {
      r = gitTry(absCwd, ["switch", name]);
    }
    return r.ok ? jsonResponse({ ok: true, out: r.out.trim() }) : jsonResponse({ ok: false, error: r.out }, 409);
  });

  api.route("GET", "/git/branches", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const cur = gitTry(absCwd, ["branch", "--show-current"]);
    // for-each-ref expands %00 (NUL) but not %x1f, so use NUL separators.
    const r = gitTry(absCwd, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname:short)%00%(upstream:lstrip=2)%00%(creatordate:relative)", "--sort=-committerdate", "refs/heads"]);
    const branches: any[] = [];
    for (const line of r.out.split("\n")) {
      if (!line.trim()) continue;
      const [name, sha, upstream, date] = line.split("\0");
      branches.push({ name: name ?? "", sha: sha ?? "", upstream: upstream ?? "", date: date ?? "" });
    }
    return jsonResponse({ ok: true, current: cur.ok ? cur.out.trim() : null, branches });
  });

  api.route("GET", "/git/remotes", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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
    // Resolve the current branch name when the client doesn't send one.
    if (!branch) {
      const cur = gitTry(absCwd, ["branch", "--show-current"]);
      if (cur.ok && cur.out.trim()) branch = cur.out.trim();
    }
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
          r = gitTry(absCwd, ["push", "--set-upstream", defaultRemote, branch]);
        } else {
          r = gitTry(absCwd, ["push"]);
        }
      } else {
        r = gitTry(absCwd, ["push", ...(remote ? [remote, branch || "HEAD"] : [])]);
      }
    } else if (pathname === "/git/pull") {
      r = gitTry(absCwd, ["pull", ...(remote ? [remote, branch] : [])]);
    } else {
      r = gitTry(absCwd, ["fetch", ...(remote ? [remote] : ["--all"])]);
    }
    return r.ok ? jsonResponse({ ok: true, out: r.out.trim() }) : jsonResponse({ ok: false, error: r.out }, 409);
  };
  api.route("POST", "/git/push", pushPullFetch);
  api.route("POST", "/git/pull", pushPullFetch);
  api.route("POST", "/git/fetch", pushPullFetch);

  api.route("GET", "/git/stash", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
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
        r = gitTry(absCwd, ["submodule", "add", url, subPath]);
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
        r = gitTry(absCwd, ["submodule", "update", "--init", "--recursive", ...(subPath ? ["--", subPath] : [])]);
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
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    return { cwd: absCwd, parsed };
  }
}
