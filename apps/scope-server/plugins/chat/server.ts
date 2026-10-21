/**
 * chat plugin — server half.
 *
 * The Chat feature's HTTP routes, extracted from server.ts so the feature owns
 * its server code the same way files/git/checkpoints/office do. The chat
 * subprocess lifecycle, the reference-library preamble and the speech-to-text
 * machinery arrive through `api.kit` (see the plugin-kit docs in server.ts and
 * plugins/README.md). Disabled → `disabledPluginForRoute()` refuses the `/chat`
 * prefix with a 403, and the Chat nav button disappears.
 *
 * `GET /chat/footer` deliberately stays core: its payload is computed from
 * server-owned state the chat module does not carry.
 */

// Where a composer attachment picked in a BROWSER or on a PHONE is written:
// inside the workspace the chat runs in, under `tmp/attachments/`, so both the
// folder the user sees and pi (which reads the file by path) agree on where it
// lives. A native (Electron) pick hands over a real path instead and never
// reaches this directory.
const ATTACH_DIR = "tmp/attachments";
// A single attachment cap. The bytes arrive base64 in a JSON body, so this also
// bounds the request size; a real coding agent reads files by path, not bytes.
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/** A filesystem-safe base name for a stored attachment (no directory, no
 *  traversal, no control characters). Empty when nothing usable is left. */
function safeAttachName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() || "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "";
}

export function activate(api: any): void {
  const {
    fs,
    path,
    jsonResponse,
    jsonBody,
    requireCwd,
    validateCwd,
    resolveWithinCwd,
    terminalCwd,
    libraryBlockFor,
    sessionSeedBlock,
    startChat,
    startChatSession,
    stopChat,
    stopAgentSession,
    killChatSession,
    pushChatPrefs,
    answerChatUi,
    chatLiveRuns,
    attachChatRun,
    chatHarnesses,
    chatHarnessModels,
    chatHarnessCommands,
    sttStatus,
    startStt,
    stopStt,
  } = api.kit;

  // ── GET /chat/status (which chat runs are live right now) ──────────────
  // The Chat view is a fresh page after every reload, but pi keeps working:
  // a run whose browser went away is still in flight, and its subprocess holds
  // the conversation context. This reports those runs so the view can restore
  // the working state (badge, run pill, Stop button) and re-attach to the
  // stream instead of looking idle. Cheap and read-only: in-memory session
  // state, no DB, no subprocess.
  api.route("GET", "/chat/status", () => jsonResponse({ runs: chatLiveRuns() }));

  // ── GET /chat/attach?sessionId=… (stream a run already in flight) ──────
  // Replays the run's events from its start, then streams it live until pi
  // settles — the same NDJSON protocol as POST /chat, so the client consumes
  // both with one reader. 409 when the run is gone (already finished or never
  // existed): the caller settles the thread from the recorded transcript
  // instead of waiting on a stream that will never produce anything.
  api.route("GET", "/chat/attach", (ctx) => {
    const sessionId = (ctx.url.searchParams.get("sessionId") || "").trim();
    if (!sessionId) return jsonResponse({ error: "missing sessionId" }, 400);
    const stream = attachChatRun(sessionId);
    if (!stream) return jsonResponse({ error: "no live run for this session", active: false }, 409);
    return stream;
  });

  // ── GET /chat/harnesses (coding-agent CLIs the composer can drive) ──────
  // Pi is one of them, but it runs through the host's own chat runner; the rest
  // are external CLIs (Claude Code, Codex CLI, opencode, …) resolved against this
  // machine's PATH. `available` is what the picker uses to mark an install as
  // missing instead of failing the first prompt with an ENOENT.
  api.route("GET", "/chat/harnesses", () => {
    const harnesses = typeof chatHarnesses === "function" ? chatHarnesses() : [];
    return jsonResponse({ harnesses, default: "pi" });
  });

  // ── GET /chat/harness-models?harness=<id> (the CLI's own model list) ────
  // `opencode models`, `kilo models` and `cursor-agent --list-models` print the
  // models that CLI is actually configured for, which no baked-in list can
  // know. Kept off the harnesses response so the picker paints immediately: the
  // page shows the curated aliases first and repaints when this answers.
  api.route("GET", "/chat/harness-models", async (ctx) => {
    const harness = (ctx.url.searchParams.get("harness") || "").trim();
    if (!harness) return jsonResponse({ error: "missing harness" }, 400);
    if (typeof chatHarnessModels !== "function") {
      return jsonResponse({ harness, models: [], source: null, error: "this host cannot list harness models" });
    }
    const result = await chatHarnessModels(harness);
    return jsonResponse({ harness, ...result });
  });

  // ── GET /chat/harness-commands?harness=<id>&cwd=<dir> (its own commands) ─
  // The composer's `/` menu asks the SELECTED harness for the slash commands it
  // actually advertises (ACP `available_commands_update`, Claude's initialize
  // response, Codex's skill list, pi's `get_commands`) instead of showing a
  // copied table that drifts when the CLI is upgraded. `cwd` matters: project
  // skills and custom commands are directory scoped. Kept off
  // /chat/harnesses so the picker paints before any CLI is started.
  api.route("GET", "/chat/harness-commands", async (ctx) => {
    const harness = (ctx.url.searchParams.get("harness") || "").trim();
    if (!harness) return jsonResponse({ error: "missing harness" }, 400);
    const requested = (ctx.url.searchParams.get("cwd") || "").trim();
    const cwd = (requested && validateCwd(requested)) || terminalCwd();
    if (typeof chatHarnessCommands !== "function") {
      return jsonResponse({ harness, commands: [], source: null, error: "this host cannot read harness commands" });
    }
    const result = await chatHarnessCommands(harness, cwd);
    return jsonResponse({ harness, ...result });
  });

  // ── POST /chat/start (pre-spawn the pi session for a workspace) ────────
  // Called when the user selects a workspace in the Chat view so `pi --mode
  // rpc` is already running before the first prompt is typed. An external
  // harness has nothing to pre-spawn — its CLI is launched per prompt — so the
  // request is answered without inventing a session id.
  api.route("POST", "/chat/start", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const absCwd = requireCwd(parsed?.cwd);
    if (absCwd instanceof Response) return absCwd;
    const harness = typeof parsed.harness === "string" ? parsed.harness.trim().toLowerCase() : "";
    const model = (typeof parsed.model === "string" ? parsed.model : "").trim() || "google/gemini-2.5-flash-lite";
    if (harness && harness !== "pi") {
      return jsonResponse({ sessionId: "", reused: false, cwd: absCwd, model, harness });
    }
    const r = startChatSession({ cwd: absCwd, model });
    return jsonResponse({ ...r, cwd: absCwd, model, harness: "pi" });
  });

  // ── POST /chat (real-time prompt to the pi coding agent) ───────────────
  api.route("POST", "/chat", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const absCwd = requireCwd(parsed?.cwd);
    if (absCwd instanceof Response) return absCwd;
    return startChat({
      cwd: absCwd,
      // The workspace's reference library rides along as a block the chat module
      // injects at the start of a fresh conversation (and never again in it).
      libraryBlock: libraryBlockFor(absCwd),
      model: typeof parsed.model === "string" ? parsed.model : "",
      // The composer's harness choice. Empty/`pi` is the original path (a
      // long-lived `pi --mode rpc` subprocess); anything else is a one-shot CLI
      // streamed by chat.ts's harness adapter.
      harness: typeof parsed.harness === "string" ? parsed.harness : "",
      // The composer's thinking-level choice; pushed to the subprocess via RPC
      // set_thinking_level so it applies without a respawn (pi otherwise caches
      // settings.json's defaultThinkingLevel at boot).
      thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : "",
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
      sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : "",
      // Only consulted when that session file cannot be resumed (it is gone, or
      // it is not a pi session): the recorded conversation is then handed to the
      // fresh session as a preamble, so the reply continues the work instead of
      // starting from nothing. Lazy — a real resume pays nothing for it.
      resumeSeed: (file: string, sid: string, reason: string) => sessionSeedBlock({ sessionFile: file, sessionId: sid, reason }),
      streamingBehavior: typeof parsed.streamingBehavior === "string" ? parsed.streamingBehavior : "",
    });
  });

  // ── POST /chat/attach (store a composer attachment in the workspace) ────
  // A browser or phone cannot hand the page a real path for a picked file, so
  // the bytes are uploaded here and written into the workspace under
  // `tmp/attachments/`; the RELATIVE path is returned and that is what the
  // prompt sends pi. A native pick (Electron) never calls this — it has the
  // real path already. Only the workspace sandbox is writable (requireCwd +
  // resolveWithinCwd), same rules as /files/save.
  api.route("POST", "/chat/attach", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const absCwd = requireCwd(parsed?.cwd);
    if (absCwd instanceof Response) return absCwd;
    const rawName = typeof parsed?.name === "string" ? parsed.name : "";
    const data = typeof parsed?.data === "string" ? parsed.data : "";
    if (!rawName || !data) return jsonResponse({ error: "missing name or data" }, 400);
    const name = safeAttachName(rawName);
    if (!name) return jsonResponse({ error: "invalid file name" }, 400);
    // Accept a bare base64 string or a full data: URL; decode defensively.
    const b64 = data.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      return jsonResponse({ error: "invalid file data" }, 400);
    }
    if (!bytes.length) return jsonResponse({ error: "empty file" }, 400);
    if (bytes.length > ATTACH_MAX_BYTES) {
      return jsonResponse({ error: `file too large (max ${Math.floor(ATTACH_MAX_BYTES / (1024 * 1024))} MB)` }, 413);
    }
    // A timestamp prefix keeps two files of the same name from clobbering each
    // other within a workspace. Forward slashes so the returned path is stable
    // across platforms.
    const rel = `${ATTACH_DIR}/${Date.now().toString(36)}-${name}`;
    const abs = resolveWithinCwd(absCwd, rel);
    if (!abs) return jsonResponse({ error: "invalid path" }, 400);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err) }, 500);
    }
    return jsonResponse({ ok: true, path: rel, name, bytes: bytes.length });
  });

  // ── POST /chat/stop (abort the agent's current run, keep the session) ────
  // A chat subprocess is aborted with `clear_queue` + `abort` so the
  // conversation context survives. A pi the user started in their OWN terminal
  // has no such channel — and no subprocess handle here — so it is signalled
  // through the pid its events carried (see stopAgentSession in server.ts).
  // `chat`/`external` say which of the two actually happened.
  api.route("POST", "/chat/stop", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
    if (!sessionId) return jsonResponse({ ok: false, sessionId, reason: "missing sessionId" }, 400);
    // Feature-detect: an older host kit has only stopChat (chat subprocesses).
    if (typeof stopAgentSession === "function") return jsonResponse({ sessionId, ...stopAgentSession(sessionId) });
    const ok = stopChat(sessionId);
    return jsonResponse({ ok, sessionId, chat: ok, external: false });
  });

  // ── POST /chat/kill (stop a chat subprocess by session id) ─────────────
  // Called when the user starts a brand-new conversation: the old pi subprocess
  // holds the previous conversation's context, so it is killed and its entry
  // removed rather than left idle to be picked up again.
  api.route("POST", "/chat/kill", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
    if (sessionId) killChatSession(sessionId);
    return jsonResponse({ ok: true });
  });

  // ── POST /chat/prefs (push model/thinking into a running chat subprocess) ─
  // Applies an updated default model / thinking level to an already-running (or
  // pre-spawned) pi session in place, so Settings changes take effect on the
  // live agent without killing it and losing the conversation context.
  api.route("POST", "/chat/prefs", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
    if (!sessionId) return jsonResponse({ error: "missing sessionId" }, 400);
    return jsonResponse(pushChatPrefs(sessionId, {
      model: typeof parsed.model === "string" ? parsed.model : "",
      thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : "",
    }));
  });

  // ── POST /chat/ui (answer an extension_ui dialog, e.g. ask_user_question) ──
  // pi blocks while an extension waits on the host for a select/input dialog
  // (the ask_user_question questionnaire). The chat view renders the dialog as
  // an answerable card; answering POSTs here, which writes the matching
  // `extension_ui_response` back to the pi subprocess's stdin so the tool
  // resolves and the agent can continue.
  api.route("POST", "/chat/ui", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
    const uiId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
    if (!sessionId || !uiId) return jsonResponse({ error: "missing sessionId or dialog id" }, 400);
    const ok = answerChatUi(sessionId, uiId, {
      value: typeof parsed.value === "string" ? parsed.value : "",
      cancelled: parsed.cancelled === true,
    });
    return jsonResponse({ ok, sessionId });
  });

  // ── GET /chat/stt/status (dictation availability for the composer mic) ──
  // Reports whether a host recorder and a Groq key are available, plus whether
  // a recording is live. The Chat view uses this to explain a greyed-out mic.
  api.route("GET", "/chat/stt/status", (ctx) => {
    const cwd = ctx.url.searchParams.get("cwd") ?? "";
    const absCwd = (cwd && validateCwd(cwd)) || terminalCwd();
    return jsonResponse(sttStatus(absCwd));
  });

  // ── POST /chat/stt/start (record the host microphone) ──────────────────
  // Mirrors the pi `speech-to-text` extension: capture on the host with
  // sox/arecord/ffmpeg, then transcribe with Groq Whisper on stop.
  api.route("POST", "/chat/stt/start", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const absCwd = requireCwd(parsed?.cwd);
    if (absCwd instanceof Response) return absCwd;
    return jsonResponse(startStt(absCwd));
  });

  // ── POST /chat/stt/stop (stop recording + transcribe via Groq) ─────────
  // Returns { ok, text } — the transcript to splice into the composer.
  api.route("POST", "/chat/stt/stop", async () => {
    return jsonResponse(await stopStt());
  });
}
