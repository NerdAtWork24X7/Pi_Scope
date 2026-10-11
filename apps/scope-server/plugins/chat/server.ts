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

export function activate(api: any): void {
  const {
    jsonResponse,
    jsonBody,
    requireCwd,
    validateCwd,
    terminalCwd,
    libraryBlockFor,
    startChat,
    startChatSession,
    stopChat,
    killChatSession,
    pushChatPrefs,
    answerChatUi,
    sttStatus,
    startStt,
    stopStt,
  } = api.kit;

  // ── POST /chat/start (pre-spawn the pi session for a workspace) ────────
  // Called when the user selects a workspace in the Chat view so `pi --mode
  // rpc` is already running before the first prompt is typed.
  api.route("POST", "/chat/start", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const absCwd = requireCwd(parsed?.cwd);
    if (absCwd instanceof Response) return absCwd;
    const r = startChatSession({ cwd: absCwd, model: typeof parsed.model === "string" ? parsed.model : "" });
    return jsonResponse({ ...r, cwd: absCwd, model: (parsed.model || "").trim() || "google/gemini-2.5-flash-lite" });
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
      // The composer's thinking-level choice; pushed to the subprocess via RPC
      // set_thinking_level so it applies without a respawn (pi otherwise caches
      // settings.json's defaultThinkingLevel at boot).
      thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : "",
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
      sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : "",
      streamingBehavior: typeof parsed.streamingBehavior === "string" ? parsed.streamingBehavior : "",
    });
  });

  // ── POST /chat/stop (abort the agent's current run, keep the session) ────
  // Unlike /chat/kill, this sends `clear_queue` + `abort` to the live pi
  // subprocess so the current run stops but the conversation context survives.
  api.route("POST", "/chat/stop", async (ctx) => {
    const { value: parsed, error } = await jsonBody(ctx.req);
    if (error) return error;
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
    const ok = sessionId ? stopChat(sessionId) : false;
    return jsonResponse({ ok, sessionId });
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
