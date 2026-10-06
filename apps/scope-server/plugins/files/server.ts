/**
 * files plugin — server half.
 *
 * The Review (Files) feature's HTTP routes. Extracted from server.ts so the
 * feature owns its server code; the shared git / diff / graph primitives arrive
 * through `api.kit` (see plugin-kit docs in server.ts and plugins/README.md).
 * Disabled → `disabledPluginForRoute()` refuses these prefixes with a 403.
 */

export function activate(api: any): void {
  const {
    fs,
    path,
    jsonResponse,
    readBody,
    validateCwd,
    git,
    parsePorcelainLine,
    porcelainStatus,
    resolveWithinCwd,
    buildRepoGraph,
  } = api.kit;

  api.route("GET", "/files/modified", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const includeIgnored = url.searchParams.get("ignored") === "1";
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      const out = git(absCwd, ["status", "--porcelain", "-uall", ...(includeIgnored ? ["--ignored"] : [])]);
      const files: any[] = [];
      for (const raw of out.split("\n")) {
        const e = parsePorcelainLine(raw);
        if (!e) continue;
        const staged = !e.ignored && e.x !== " " && e.x !== "?";
        files.push({ path: e.path, status: porcelainStatus(e), staged, renamed_from: e.renamedFrom });
      }
      return jsonResponse({ cwd: absCwd, git: true, files });
    } catch (err: any) {
      return jsonResponse({ cwd: absCwd, git: false, files: [], error: String(err?.message ?? err).split("\n")[0] });
    }
  });

  api.route("GET", "/files/diff", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    const file = url.searchParams.get("file") ?? "";
    if (!cwd || !file) return jsonResponse({ error: "missing cwd or file" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const absFile = resolveWithinCwd(absCwd, file);
    if (!absFile) return jsonResponse({ error: "invalid file path" }, 400);
    try {
      const newExists = fs.existsSync(absFile) && fs.statSync(absFile).isFile();
      const newContent = newExists ? fs.readFileSync(absFile, "utf8") : "";
      if (newContent.includes("\u0000")) {
        return jsonResponse({ cwd: absCwd, file, binary: true, old: "", new: "" });
      }
      let oldContent = "";
      try { oldContent = git(absCwd, ["show", `HEAD:${file}`]); } catch { oldContent = ""; }
      return jsonResponse({ cwd: absCwd, file, binary: false, old: oldContent, new: newContent });
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  });

  api.route("GET", "/files/graph", async (ctx) => {
    const url = ctx.url;
    const cwd = url.searchParams.get("cwd") ?? "";
    if (!cwd) return jsonResponse({ error: "missing cwd" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    try {
      return jsonResponse(buildRepoGraph(absCwd));
    } catch (err: any) {
      return jsonResponse({
        cwd: absCwd, git: false, error: String(err?.message ?? err).split("\n")[0],
        modules: [], edges: [], fileNodes: [], fileEdges: [], changed: [], head: null,
        stats: { files: 0, modules: 0, changedFiles: 0, add: 0, del: 0, truncated: false },
      });
    }
  });

  api.route("POST", "/files/save", async (ctx) => {
    const req = ctx.req;
    let bodyText: string;
    try { bodyText = await readBody(req); } catch (err: any) { return jsonResponse({ error: err.message }, 413); }
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const cwd = parsed.cwd ?? "";
    const file = parsed.file ?? "";
    const content = typeof parsed.content === "string" ? parsed.content : "";
    if (!cwd || !file) return jsonResponse({ error: "missing cwd or file" }, 400);
    const absCwd = validateCwd(cwd);
    if (!absCwd) return jsonResponse({ error: "invalid or disallowed cwd" }, 400);
    const absFile = resolveWithinCwd(absCwd, file);
    if (!absFile) return jsonResponse({ error: "invalid file path" }, 400);
    try {
      fs.mkdirSync(path.dirname(absFile), { recursive: true });
      fs.writeFileSync(absFile, content, "utf8");
      return jsonResponse({ ok: true, file, bytes: Buffer.byteLength(content, "utf8") });
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err).split("\n")[0] }, 500);
    }
  });
}
