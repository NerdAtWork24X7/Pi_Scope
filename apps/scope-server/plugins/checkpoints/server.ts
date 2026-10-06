/**
 * checkpoints plugin — server half.
 *
 * Git-backed working-tree snapshots: create / list / restore / merge / delete.
 * Extracted from server.ts so the feature owns its server code; git primitives
 * arrive through `api.kit`.
 */

/** A checkpoint ref is exactly refs/checkpoints/<ns>/<id>: `ns` is a base64url
 *  slice of the cwd and `id` is the generated timestamp/random suffix. Pinning
 *  the shape keeps a caller-supplied ref from naming another namespace or
 *  handing git an unexpected value, and both parts are also used to build the
 *  `checkpoints/<ns>/<id>` branch name. */
const CHECKPOINT_REF_RE = /^refs\/checkpoints\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

export function activate(api: any): void {
  const {
    jsonResponse,
    readBody,
    validateCwd,
    git,
    ensureGitRepo,
    rejectOptionLike,
  } = api.kit;

  api.route("POST", "/checkpoints/create", async (ctx) => {
    const req = ctx.req;
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = parsed.cwd ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const label = typeof parsed.label === "string" && parsed.label.trim() ? parsed.label.trim().slice(0, 120) : "";
    try {
      const { initialized } = ensureGitRepo(absCwd);
      const ns = cwdNs(absCwd);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const message = `chk: ${id}${label ? " · " + label : ""}`;
      // Each checkpoint gets its own branch (checkpoints/<ns>/<id>) instead of a
      // shared ns branch, so deleting one checkpoint can delete its branch without
      // touching others. commit-tree + branch -f creates the branch without moving
      // the working tree; we then `git switch` onto it so HEAD tracks the checkpoint.
      const cpBranch = `checkpoints/${ns}/${id}`;
      git(absCwd, ["add", "-A"]);
      const tree = git(absCwd, ["write-tree"]).trim();
      // Parent: most recent existing checkpoint commit for this cwd (keeps a linear
      // history); fall back to current HEAD when this is the first checkpoint.
      let parent: string | null = null;
      try {
        git(absCwd, ["rev-parse", "--verify", "HEAD"]);
        parent = "HEAD";
      } catch {}
      try {
        const prev = git(absCwd, ["for-each-ref", "--format=%(objectname)", "--sort=-creatordate", `refs/checkpoints/${ns}/*`])
          .split("\n").map((l: string) => l.trim()).find((l: string) => l);
        if (prev) parent = prev;
      } catch {}
      const gitConfig = { "user.name": "Pi Scope", "user.email": "scope@localhost" };
      const commitArgs = ["commit-tree", tree, "-m", message];
      if (parent) commitArgs.push("-p", parent);
      const sha = git(absCwd, commitArgs, gitConfig).trim();
      git(absCwd, ["branch", "-f", cpBranch, sha]);
      git(absCwd, ["switch", cpBranch]); // move HEAD onto the new checkpoint branch (working tree unchanged)
      const ref = `refs/checkpoints/${ns}/${id}`;
      git(absCwd, ["update-ref", ref, sha]);
      git(absCwd, ["reset", "-q"]); // restore index to HEAD (now cpBranch); working tree unchanged
      return jsonResponse({ ok: true, ref, sha, message, session: ns, ts: new Date().toISOString(), initializedGit: initialized });
    } catch (err: any) {
      return jsonResponse({ git: true, ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  });

  api.route("GET", "/checkpoints/list", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const ns = cwdNs(absCwd);
    const glob = `refs/checkpoints/${ns}/*`;
    try {
      const out = git(absCwd, ["for-each-ref", "--format=%(refname) %(objectname) %(creatordate:iso-strict) %(contents:subject)", glob]);
      const items: any[] = [];
      for (const raw of out.split("\n")) {
        if (!raw.trim()) continue;
        const m = raw.match(/^(\S+) (\S+) (\S+)[ \t]+(.*)$/);
        if (!m) continue;
        const [, ref, sha, ts, subject] = m;
        items.push({ ref, sha, ts, message: subject, session: ns });
      }
      items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      return jsonResponse({ git: true, items });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.includes("not a git repository") || msg.includes("did not match")) {
        return jsonResponse({ git: false, items: [] });
      }
      return jsonResponse({ git: false, items: [], error: msg.split("\n")[0] });
    }
  });

  api.route("POST", "/checkpoints/restore", async (ctx) => {
    const req = ctx.req;
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const ref = parsed.ref ?? "";
    if (!CHECKPOINT_REF_RE.test(ref)) {
      return jsonResponse({ error: "ref must be a checkpoint ref (refs/checkpoints/...)" }, 400);
    }
    const cwd = parsed.cwd ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      git(absCwd, ["rev-parse", "--verify", ref]);
      git(absCwd, ["reset", "--hard", ref]);
      git(absCwd, ["clean", "-fdq"]);
      const sha = git(absCwd, ["rev-parse", "HEAD"]).trim();
      return jsonResponse({ ok: true, ref, sha });
    } catch (err: any) {
      return jsonResponse({ ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  });

  api.route("GET", "/checkpoints/branches", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      git(absCwd, ["rev-parse", "--is-inside-work-tree"]);
      const current = git(absCwd, ["branch", "--show-current"]).trim();
      const out = git(absCwd, ["for-each-ref", "--format=%(refname:lstrip=2)", "--sort=-committerdate", "refs/heads"]);
      const branches: string[] = [];
      for (const line of out.split("\n")) {
        const name = line.trim();
        if (!name) continue;
        branches.push(name);
      }
      return jsonResponse({ ok: true, branches, current });
    } catch (err: any) {
      return jsonResponse({ ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  });

  api.route("POST", "/checkpoints/merge", async (ctx) => {
    const req = ctx.req;
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const ref = parsed.ref ?? "";
    if (!CHECKPOINT_REF_RE.test(ref)) {
      return jsonResponse({ error: "ref must be a checkpoint ref (refs/checkpoints/...)" }, 400);
    }
    const target = typeof parsed.target === "string" && parsed.target.trim() ? parsed.target.trim() : "";
    if (!target) return jsonResponse({ error: "missing target branch" }, 400);
    // `target` becomes a git argument (`switch`) and a ref name
    // (`refs/heads/<target>`); a leading dash or whitespace would be an option
    // or a malformed ref.
    if (rejectOptionLike(target) || /\s/.test(target)) return jsonResponse({ error: "invalid target branch" }, 400);
    const cwd = parsed.cwd ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      const parts = ref.split("/");
      const id = parts.pop() ?? "";
      const ns = parts.pop() ?? "";
      const cpBranch = `checkpoints/${ns}/${id}`;
      // Verify both the checkpoint ref and the target branch exist.
      git(absCwd, ["rev-parse", "--verify", ref]);
      try { git(absCwd, ["rev-parse", "--verify", `refs/heads/${target}`]); }
      catch { return jsonResponse({ ok: false, git: true, error: `target branch '${target}' does not exist` }, 400); }
      if (target === cpBranch) {
        return jsonResponse({ ok: false, git: true, error: "cannot merge a checkpoint branch into itself" }, 400);
      }
      // Refuse to proceed if the working tree is dirty so we don't stash or lose changes.
      const status = git(absCwd, ["status", "--porcelain"]);
      if (status.trim().length > 0) {
        return jsonResponse({ ok: false, git: true, error: "working tree has uncommitted changes — commit or stash them before merging" }, 409);
      }
      // Switch to target branch, then merge the checkpoint ref into it.
      git(absCwd, ["switch", target]);
      try {
        git(absCwd, ["merge", "--no-ff", "-m", `Merge checkpoint ${id} into ${target}`, ref]);
      } catch (mergeErr: any) {
        const conflictMsg = String(mergeErr?.message ?? mergeErr).split("\n")[0];
        return jsonResponse({ ok: false, git: true, conflict: true, error: `merge conflict: ${conflictMsg}. Resolve conflicts manually in your terminal.` }, 409);
      }
      const sha = git(absCwd, ["rev-parse", "HEAD"]).trim();
      return jsonResponse({ ok: true, ref, target, sha, branch: cpBranch });
    } catch (err: any) {
      return jsonResponse({ ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  });

  api.route("POST", "/checkpoints/delete", async (ctx) => {
    const req = ctx.req;
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const ref = parsed.ref ?? "";
    if (!CHECKPOINT_REF_RE.test(ref)) {
      return jsonResponse({ error: "ref must be a checkpoint ref (refs/checkpoints/...)" }, 400);
    }
    const cwd = parsed.cwd ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      const parts = ref.split("/");
      const id = parts[parts.length - 1];
      const ns = parts[2];
      let msg = "";
      if (parsed.deleteBranch) {
        const cpBranch = `checkpoints/${ns}/${id}`;
        // git can't delete the currently checked-out branch. Move HEAD to the
        // parent commit first — preferring an existing branch that already points
        // there (e.g. the previous checkpoint branch or the base branch) — then
        // delete it. If there are conflicting uncommitted changes we can't switch,
        // so report and bail out without deleting anything.
        try {
          const cur = git(absCwd, ["branch", "--show-current"]).trim();
          if (cur === cpBranch) {
            const parent = git(absCwd, ["rev-parse", `${cpBranch}^`]).trim();
            const onParent = git(absCwd, ["for-each-ref", "--format=%(refname:lstrip=2)", "--points-at", parent, "refs/heads"])
              .split("\n").map((l: string) => l.trim()).find((l: string) => l && l !== cpBranch);
            if (onParent) { git(absCwd, ["switch", onParent]); msg = `switched to '${onParent}'`; }
            else { git(absCwd, ["switch", "--detach", parent]); msg = `switched to detached HEAD ${parent.slice(0, 8)}`; }
          }
        } catch {
          return jsonResponse({ ok: false, git: true, error: "checkpoint branch is checked out and has uncommitted changes — commit or stash them, then merge into another branch before deleting" }, 409);
        }
        try { git(absCwd, ["branch", "-D", cpBranch]); } catch {}
      }
      git(absCwd, ["update-ref", "-d", ref]);

      const out: any = { ok: true, ref, deleteBranch: !!parsed.deleteBranch };
      if (msg) out.message = `checkpoint branch was checked out — ${msg} and deleted. Merge any uncommitted changes into another branch first.`;
      return jsonResponse(out);
    } catch (err: any) {
      return jsonResponse({ ok: false, error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  });

  function cwdNs(cwd: string): string {
    return "cwd-" + Buffer.from(cwd || "unknown").toString("base64url").slice(0, 16);
  }
}
