// End-to-end tests for the Office view, run in headless Chromium against the
// mock backend in ./mock-backend.mjs (which serves the real public/ assets, and
// the plugin's own client bundle from plugins/office/ — the Office is a
// standalone plugin, so nothing about it lives in public/ or index.html).
//
//   node --test apps/scope-server/test/office.e2e.test.mjs
//
// The office draws one cubicle per agent: the orchestrator in its own office at
// the top-left of the plan, the meeting room beside it, and one room per team
// split two-left / two-right of a center pathway, animating the desks that are
// working. These tests assert the *state* the animation keys off (the pod's
// class), the floor-plan geometry, the cubicle furniture (partition walls,
// desk, screen, chair, seated agent), the on-leave state for a disabled agent,
// the hover popup fed by the agent's own session events, the live activity
// label from SSE, and the empty state — the parts that can silently break
// without a pixel diff.

import { test, before, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend, defaultTeam, makeSession } from "./mock-backend.mjs";
import { launchBrowser, sleep } from "./harness.mjs";

const WS = "/tmp/pi-scope-e2e/alpha";
const SID = "s1";

let browser;
let mock;
let context = null;
let page = null;
let pageErrors = [];

before(async () => {
  mock = await startMockBackend();
  browser = await launchBrowser();
});
after(async () => {
  if (browser) await browser.close();
  if (mock) await mock.close();
});
beforeEach(() => { mock.reset(); });
afterEach(async () => {
  if (context) await context.close();
  context = null;
  page = null;
});

/** Seed sessions + team, then load the app directly on the Office view. */
async function boot({ sessions = [], team, events, defs, office } = {}) {
  mock.setSessions(sessions);
  mock.setTeam(team || defaultTeam());
  if (office) mock.setOffice(office);
  if (defs) mock.setAgentDefs(defs);
  if (events) for (const [sid, list] of Object.entries(events)) mock.setEvents(sid, list);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Failed requests are recorded with their URL by the response listener
    // below; the browser's echo of them carries no URL to inspect.
    if (/Failed to load resource/.test(m.text())) return;
    pageErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    // Chromium asks for /favicon.ico even though index.html declares logo.png,
    // and the real server 404s it too — not an app error, so it is not counted.
    if (/\/favicon\.ico$/.test(r.url())) return;
    pageErrors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  // Views are deep-linked through the URL hash (`#view=<id>`), like the other
  // registered views.
  await page.goto(`${mock.base}/?token=test-token#view=office`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#office-pane .office-pod", { timeout: 15_000 });
  return page;
}

const pod = (key) => page.locator(`#office-pane .office-pod[data-key="${key}"]`);
const counts = () => page.textContent("#office-counts");
const board = () => page.locator("#office-board-backdrop");
/** One board column (todo / planned / in_progress / done). */
const kcol = (status) => page.locator(`#office-board-backdrop .office-kcol.${status}`);
/** The titles in one board column, in the order the board draws them. */
const colTitles = (status) => kcol(status).locator(".office-task-title").allTextContents();

/** Poll the mock's own state — for waits on a server write, not a repaint. */
async function until(fn, what, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** An agent's own events, as `GET /sessions/<sid>/events` returns them. */
function agentEvents(list) {
  const ts = new Date().toISOString();
  return list.map((e, i) => ({ event_id: `e${i + 1}`, session_id: SID, seq: i + 1, ts, type: e.type, payload: e.payload }));
}

/** Four teams, so the plan really has two rooms on each side of the pathway. */
function fourTeams() {
  return defaultTeam({
    activeTeam: "dev",
    teamsOrder: ["dev", "review", "ops", "docs"],
    teams: {
      dev: [{ name: "orchestrator" }, { name: "builder" }],
      review: [{ name: "critic" }],
      ops: [{ name: "deployer" }],
      docs: [{ name: "writer" }],
    },
  });
}

describe("office view", () => {
  test("each team gets a room, and every member gets a cubicle in it", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" }),
      ],
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // One room per team in the roster, the orchestrator's own office, and the
    // meeting room.
    const dev = page.locator('#office-pane .office-room[data-room="team:dev"]');
    const review = page.locator('#office-pane .office-room[data-room="team:review"]');
    const meeting = page.locator('#office-pane .office-room[data-room="meeting"]');
    const orch = page.locator('#office-pane .office-room[data-room="orchestrator"]');
    assert.equal(await dev.count(), 1, "the dev team has a room");
    assert.equal(await review.count(), 1, "the review team has a room");
    assert.equal(await meeting.count(), 1, "there is a meeting room");
    assert.equal(await orch.count(), 1, "the orchestrator has its own office");
    assert.ok(await dev.evaluate((el) => el.classList.contains("active")), "the active team's room is marked");
    assert.equal(await review.evaluate((el) => el.classList.contains("active")), false);

    // Members sit inside their own room, not the other team's — and the
    // orchestrator sits in its own office, never in a team's room.
    assert.equal(await dev.locator('.office-pod[data-key="builder"]').count(), 1);
    assert.equal(await dev.locator('.office-pod[data-key="orchestrator"]').count(), 0);
    assert.equal(await orch.locator('.office-pod[data-key="orchestrator"]').count(), 1);
    assert.equal(await review.locator('.office-pod[data-key="critic"]').count(), 1);
    assert.equal(await review.locator('.office-pod[data-key="builder"]').count(), 0);
    assert.equal(await meeting.locator(".office-roundtable").count(), 1);

    // The header counts the rooms' agents: builder works, the rest idle.
    assert.match(await counts(), /1\s*working/);
    assert.match(await counts(), /2\s*idle/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("every team keeps a room, and an inactive team can be activated from the floor", async () => {
    // Three teams that share members: no team may be swallowed by the others.
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        activeTeam: "dev",
        teamsOrder: ["dev", "review", "ops"],
        teams: {
          dev: [{ name: "orchestrator" }, { name: "builder" }],
          review: [{ name: "builder" }, { name: "critic" }],
          ops: [{ name: "builder" }],
        },
      }),
    });
    await page.waitForSelector('#office-pane .office-room[data-room="team:ops"]');

    // All three rooms exist, and a shared agent holds a desk in each team it is on.
    for (const t of ["dev", "review", "ops"]) {
      const room = page.locator(`#office-pane .office-room[data-room="team:${t}"]`);
      assert.equal(await room.count(), 1, `the ${t} team keeps its room`);
      assert.equal(await room.locator('.office-pod[data-key="builder"]').count(), 1, `builder has a desk in ${t}`);
    }

    const dev = page.locator('#office-pane .office-room[data-room="team:dev"]');
    const review = page.locator('#office-pane .office-room[data-room="team:review"]');
    assert.ok(await dev.evaluate((el) => el.classList.contains("active")), "the active team is marked");
    assert.equal(await dev.locator(".office-room-active").count(), 1, "the active team is badged");
    assert.equal(await dev.locator(".office-room-pick").count(), 0, "the active team offers no Activate control");
    assert.equal(await review.evaluate((el) => el.classList.contains("active")), false, "the inactive team is not marked");
    assert.equal(await review.locator(".office-room-pick").count(), 1, "the inactive team offers Activate");
    assert.match(await review.locator(".office-room-pick").textContent(), /activate/i);

    // Clicking Activate switches the roster and the floor highlight with it.
    await review.locator(".office-room-pick").click();
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-room[data-room="team:review"]')?.classList.contains("active"),
    );
    assert.equal(await dev.evaluate((el) => el.classList.contains("active")), false, "the old active team is no longer active");
    assert.equal(await dev.locator(".office-room-pick").count(), 1, "the old active team now offers Activate");
    assert.equal(await review.locator(".office-room-active").count(), 1, "the new active team is badged");
    assert.equal(mock.state.team.activeTeam, "review", "the switch was persisted to the server");

    // The desks in the newly active team still hold the agent's live status.
    assert.equal(await review.locator('.office-pod[data-key="builder"]').count(), 1);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a desk on an inactive team stays dormant even when the same agent works on the active team", async () => {
    // The same subagent sits on both teams. Only the active team is staffed, so
    // its desk lights up while the inactive team's desk for that agent must not.
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "file_reader", last_turn_event: "turn_start" })],
      team: defaultTeam({
        activeTeam: "alpha",
        teamsOrder: ["alpha", "beta"],
        teams: {
          alpha: [{ name: "orchestrator" }, { name: "file_reader" }],
          beta: [{ name: "file_reader" }],
        },
      }),
    });
    const desk = (t) => page.locator(`#office-pane .office-room[data-room="team:${t}"] .office-pod[data-key="file_reader"]`);

    // The active team's desk animates the running subagent…
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-room[data-room="team:alpha"] .office-pod[data-key="file_reader"]')?.classList.contains("working"),
    );
    assert.ok(await desk("alpha").evaluate((el) => el.classList.contains("working")), "the active team's desk is working");

    // …and the inactive team's desk for the same agent stays idle.
    assert.equal(await desk("beta").evaluate((el) => el.classList.contains("working")), false, "the inactive team's desk never lights up");
    assert.ok(await desk("beta").evaluate((el) => el.classList.contains("idle")), "it reads as idle instead");
    assert.match(await desk("beta").getAttribute("title"), /team inactive/i);
    assert.match(await desk("alpha").getAttribute("title"), /working/i);

    // Making the other team active moves the live status with it.
    await page.locator('#office-pane .office-room[data-room="team:beta"] .office-room-pick').click();
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-room[data-room="team:beta"] .office-pod[data-key="file_reader"]')?.classList.contains("working"),
    );
    assert.ok(await desk("beta").evaluate((el) => el.classList.contains("working")), "the newly active team's desk works");
    assert.equal(await desk("alpha").evaluate((el) => el.classList.contains("working")), false, "and the old active team's desk goes dormant");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("firing a subagent removes it from the team, and hiring adds one back", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder" }),
        makeSession({ session_id: "s2", cwd: WS, agent_name: "critic" }),
      ],
      // A reference already assigned to the name being hired, so the generated
      // definition can be checked against the library.
      team: defaultTeam({ library: [{ id: "lib_1", path: `${WS}/docs/arch.md`, note: "the API map", target: "builder" }] }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // The floor carries no hire / fire / md / name controls: each desk has just
    // its own **off duty** toggle and the **settings** popup that gathers them.
    for (const sel of [".office-fire", ".office-hire", '.office-act[data-act="md"]', '.office-act[data-act="rename"]']) {
      assert.equal(await page.locator(`#office-pane ${sel}`).count(), 0, `${sel} is not drawn on the floor`);
    }
    assert.equal(await pod("orchestrator").locator('.office-act[data-act="settings"]').count(), 1, "the orchestrator configures from settings");
    assert.equal(await pod("builder").locator('.office-act[data-act="settings"]').count(), 1, "a team desk offers settings");
    assert.equal(await pod("orchestrator").locator(".office-act.duty").count(), 0, "the orchestrator has no duty toggle");

    // Fire lives in the desk's settings popup now.
    await pod("builder").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    assert.match(await page.textContent("#office-set-sub"), /builder/);
    assert.equal(await page.locator("#office-settings-backdrop .office-set-fire").count(), 1, "the popup carries fire");
    await page.click("#office-settings-backdrop .office-set-fire");
    // The desk leaves the floor — not just the room: a fired subagent's old
    // sessions must not resurrect it under "Ad-hoc desks".
    await page.waitForFunction(() => !document.querySelector('#office-pane .office-pod[data-key="builder"]'));
    await page.waitForSelector("#office-settings-backdrop", { state: "detached" });
    assert.equal((mock.state.team.teams.dev || []).some((m) => m.name === "builder"), false, "the subagent left the team");
    assert.equal(await page.locator('#office-pane .office-room[data-room="team:dev"] .office-pod').count(), 0, "the desk left its room");
    assert.equal(await page.locator('#office-pane .office-pod').count(), 2, "only the orchestrator and critic keep desks");

    // Hire lives in the orchestrator's settings popup: choose a team, then the
    // roomy form opens and adds a member — a display name, a model and a fresh
    // agents/<name>.md definition.
    await pod("orchestrator").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.selectOption("#office-settings-backdrop .office-set-hire-team", "dev");
    await page.click("#office-settings-backdrop .office-set-hire");
    await page.waitForSelector("#office-dlg-backdrop");
    assert.equal(await page.inputValue("#office-hire-name"), "", "the hire form starts empty");
    // Definition starts from the default template, and its opening line follows
    // the name until the user writes their own body.
    assert.match(await page.inputValue("#office-hire-prompt"), /^You are a subagent on this team\.\n\n## Job\n/);
    assert.match(await page.inputValue("#office-hire-prompt"), /Read the reference files assigned to you/);
    await page.fill("#office-hire-name", "builder");
    await page.fill("#office-hire-display", "Bob");
    assert.match(await page.inputValue("#office-hire-prompt"), /^You are Bob, a subagent on this team\./, "the template follows the display name");
    await page.fill("#office-hire-prompt", "Build the thing.");
    await page.fill("#office-hire-display", "Robert");
    assert.equal(await page.inputValue("#office-hire-prompt"), "Build the thing.", "a body of the user's own is never overwritten");
    await page.fill("#office-hire-display", "Bob");
    // The hire form gets the roomy box: four fields and the definition body
    // have to fit without crowding.
    const hireBox = await page.locator("#office-dlg-backdrop .office-dialog").boundingBox();
    assert.ok(hireBox.width >= 860, `the hire dialog is wide (${hireBox.width}px)`);
    assert.ok(hireBox.height >= 420, `and tall (${hireBox.height}px)`);
    assert.ok(
      await page.locator("#office-dlg-backdrop .office-dialog").evaluate((el) => el.classList.contains("office-dialog-wide")),
      "the hire form uses the wide layout",
    );
    assert.match(await page.locator("#office-dlg-backdrop .office-dialog-hint").textContent(), /Reference files template/);
    // The model picker lists EVERY known model, grouped one <optgroup> per
    // provider like the Settings page — including providers the user has not
    // enabled (the fixture enables google + deepseek only).
    const groups = await page.locator("#office-hire-model optgroup").evaluateAll((els) => els.map((e) => e.label));
    assert.deepEqual(groups, ["anthropic", "deepseek", "google"], "a group per provider, sorted");
    const modelValues = await page.locator("#office-hire-model option").evaluateAll((els) => els.map((e) => e.value));
    assert.equal(modelValues[0], "", "the empty value still means the team default");
    for (const m of ["google/gemini-2.5-flash-lite", "deepseek/deepseek-v4-flash", "anthropic/claude-sonnet-4"]) {
      assert.ok(modelValues.includes(m), `${m} is offered`);
    }
    // Options are labelled by id within their provider group, not by full key.
    assert.ok(
      (await page.locator('#office-hire-model optgroup[label="anthropic"] option').allTextContents()).includes("claude-sonnet-4"),
      "the label drops the provider prefix",
    );
    // The short fields pair up two to a row, and the body gets the full width
    // beneath them — nothing stacks into one narrow column.
    const boxOf = (sel) => page.locator(sel).boundingBox();
    const name = await boxOf("#office-hire-name");
    const display = await boxOf("#office-hire-display");
    const model = await boxOf("#office-hire-model");
    assert.ok(Math.abs(name.y - display.y) < 4, "name and display name share a row");
    assert.ok(display.x > name.x + name.width - 4, "and sit side by side");
    assert.ok(model.y > name.y + name.height - 4, "the model drops to the next row");
    const promptBox = await boxOf("#office-hire-prompt");
    assert.ok(promptBox.height >= 140, `the definition body has room to write (${promptBox.height}px)`);
    assert.ok(promptBox.width >= name.width * 1.9, `and spans the dialog (${promptBox.width}px)`);
    assert.ok(promptBox.y > model.y, "the body sits below the short fields");
    await page.selectOption("#office-hire-model", "deepseek/deepseek-v4-flash");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForSelector("#office-dlg-backdrop", { state: "detached" });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    const member = (mock.state.team.teams.dev || []).find((m) => m.name === "builder");
    assert.ok(member, "the subagent is back on the team");
    assert.equal(member.displayName, "Bob", "the display name was stored on the member");
    assert.equal(member.model, "deepseek/deepseek-v4-flash", "the model was stored on the member");
    const def = mock.state.agentDefs.find((d) => d.file === "builder.md");
    assert.ok(def, "the hire created agents/builder.md");
    assert.match(def.content, /^---\nname: builder\n/);
    assert.match(def.content, /Build the thing\./);
    // The definition carries a reference template: the library entries assigned
    // to this subagent, in workspace-relative form.
    assert.match(def.content, /^## Reference files$/m);
    assert.match(def.content, /^- `[^`]*docs\/arch\.md` — the API map$/m);
    assert.match(def.content, /injected at the start of every new conversation/);

    // Hiring someone with no references yet still gets the section, as a
    // commented skeleton, so every subagent definition has the same shape.
    await page.selectOption("#office-settings-backdrop .office-set-hire-team", "review");
    await page.click("#office-settings-backdrop .office-set-hire");
    await page.waitForSelector("#office-dlg-backdrop");
    await page.fill("#office-hire-name", "writer");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForSelector("#office-dlg-backdrop", { state: "detached" });
    const writer = mock.state.agentDefs.find((d) => d.file === "writer.md");
    assert.ok(writer, "the second hire created agents/writer.md");
    // Only the name was typed: the definition carries the default template.
    assert.match(writer.content, /^You are writer, a subagent on this team\.$/m);
    assert.match(writer.content, /^## Job$/m);
    assert.match(writer.content, /^## Reference files$/m);
    assert.match(writer.content, /<!-- For example:/);
    assert.match(writer.content, /- `src\/app\.ts` — the HTTP surface/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the on-duty control enables and disables a subagent", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // On duty → the control takes them off duty (disable).
    const duty = pod("builder").locator(".office-act.duty");
    assert.match(await duty.textContent(), /off duty/i, "an enabled subagent offers to go off duty");
    await duty.click();
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"] .office-act.duty.off');
    assert.ok(mock.state.team.disabledAgents.includes("builder"), "the server disabled the subagent");
    assert.match(await counts(), /1\s*off duty/);
    assert.match(await pod("builder").locator(".office-act.duty").textContent(), /on duty/i, "an off-duty subagent offers to come back");
    assert.ok(await pod("builder").evaluate((el) => el.classList.contains("leave")), "the desk is unmanned");

    // …and clicking again brings them back on duty.
    await pod("builder").locator(".office-act.duty").click();
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"] .office-act.duty:not(.off)');
    assert.equal(mock.state.team.disabledAgents.includes("builder"), false, "the server re-enabled the subagent");
    assert.equal(await pod("builder").evaluate((el) => el.classList.contains("leave")), false, "the desk is staffed again");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a subagent's duty is per team — one desk's toggle leaves the other team's seat alone", async () => {
    // `builder` sits on both dev and review. Teams are independent, so taking
    // the member off duty on one desk must not darken the other team's seat.
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        teams: {
          dev: [
            { name: "orchestrator", model: "google/gemini-2.5-flash-lite", active: true },
            { name: "builder", model: "google/gemini-2.5-flash-lite", active: true },
          ],
          review: [{ name: "builder", model: "google/gemini-2.5-flash-lite", active: true }],
        },
      }),
    });
    const deskIn = (room) => page.locator(`#office-pane .office-room[data-room="team:${room}"] .office-pod[data-key="builder"] .office-act.duty`);
    const row = (teamName) => (mock.state.team.teams[teamName] || []).find((m) => m.name === "builder");
    await deskIn("review").waitFor();

    // The inactive `review` team's desk: only its own roster row flips, and the
    // running session's off-list (which speaks for the active team) is untouched.
    await deskIn("review").click();
    await page.waitForSelector('#office-pane .office-room[data-room="team:review"] .office-pod[data-key="builder"] .office-act.duty.off');
    assert.equal(row("review").active, false, "the review row goes off duty");
    assert.equal(row("dev").active, true, "the dev row keeps its own duty");
    assert.equal(mock.state.team.disabledAgents.includes("builder"), false, "the running team's off-list is untouched");
    assert.ok(!(await deskIn("dev").evaluate((el) => el.classList.contains("off"))), "the dev desk stays on duty");

    // The active team's desk does silence the running session; with both seats
    // empty the header counts the agent as off duty.
    await deskIn("dev").click();
    await page.waitForSelector('#office-pane .office-room[data-room="team:dev"] .office-pod[data-key="builder"] .office-act.duty.off');
    assert.equal(row("dev").active, false, "the dev row goes off duty");
    assert.ok(mock.state.team.disabledAgents.includes("builder"), "the active team's off-list names the member");
    assert.equal(row("review").active, false, "the review row is still off duty");
    assert.match(await counts(), /1\s*off duty/);

    // …and bringing one seat back leaves the other team's row alone.
    await deskIn("review").click();
    await page.waitForSelector('#office-pane .office-room[data-room="team:review"] .office-pod[data-key="builder"] .office-act.duty:not(.off)');
    assert.equal(row("review").active, true, "the review row is back on duty");
    assert.equal(row("dev").active, false, "and the dev row is untouched by the review desk");
    assert.ok(mock.state.team.disabledAgents.includes("builder"), "the active team's desk is still the one off duty");
    assert.ok(await deskIn("dev").evaluate((el) => el.classList.contains("off")), "the dev seat is still empty");

    // The settings popup follows the desk it was opened from: dev is off duty,
    // review is on, and the popup's own duty button flips only that team.
    const settingsIn = (room) => page.locator(`#office-pane .office-room[data-room="team:${room}"] .office-pod[data-key="builder"] .office-act[data-act="settings"]`);
    await settingsIn("dev").click();
    await page.waitForSelector("#office-settings-backdrop");
    assert.match(await page.textContent("#office-settings-backdrop"), /off duty on dev/);
    assert.equal(await page.locator("#office-settings-backdrop .office-set-duty.off").count(), 1, "the popup offers to bring the dev seat back");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#office-settings-backdrop", { state: "detached" });

    await settingsIn("review").click();
    await page.waitForSelector("#office-settings-backdrop");
    assert.match(await page.textContent("#office-settings-backdrop"), /on duty on review/);
    await page.click("#office-settings-backdrop .office-set-duty");
    await page.waitForFunction(() => document.querySelector("#office-settings-backdrop")?.textContent.includes("off duty on review"));
    assert.equal(row("review").active, false, "the popup's button flips the review row");
    assert.equal(row("dev").active, false, "and leaves the dev row as it was");
    await page.keyboard.press("Escape");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("switching teams keeps each team's own duty", async () => {
    // `builder` sits on both dev and review. Duty set on the team we leave must
    // not follow the member to the team we switch to: the running session's
    // off-list is rebuilt from the roster of whichever team is active.
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        activeTeam: "dev",
        teams: {
          dev: [
            { name: "orchestrator", model: "google/gemini-2.5-flash-lite", active: true },
            { name: "builder", model: "google/gemini-2.5-flash-lite", active: true },
          ],
          review: [{ name: "builder", model: "google/gemini-2.5-flash-lite", active: true }],
        },
      }),
    });
    const deskIn = (room) => page.locator(`#office-pane .office-room[data-room="team:${room}"] .office-pod[data-key="builder"] .office-act.duty`);
    const row = (teamName) => (mock.state.team.teams[teamName] || []).find((m) => m.name === "builder");
    await deskIn("dev").waitFor();

    // Off duty on the RUNNING team (dev): its row flips and the off-list names it.
    await deskIn("dev").click();
    await page.waitForSelector('#office-pane .office-room[data-room="team:dev"] .office-pod[data-key="builder"] .office-act.duty.off');
    assert.equal(row("dev").active, false, "the dev row goes off duty");
    assert.ok(mock.state.team.disabledAgents.includes("builder"), "the running team's off-list names it");

    // Switch to review, whose own roster still has builder: it comes on duty
    // there, because duty never crosses teams.
    await page.click('#office-pane .office-room[data-room="team:review"] .office-room-pick[data-team="review"]');
    await page.waitForSelector('#office-pane .office-room[data-room="team:review"].active');
    assert.equal(row("review").active, true, "the review roster row is untouched");
    assert.equal(mock.state.team.disabledAgents.includes("builder"), false, "the new running team's off-list follows its own rows");
    assert.ok(!(await deskIn("review").evaluate((el) => el.classList.contains("off"))), "the review desk is on duty");

    // …and back on dev the seat is empty again, read from dev's own row.
    await page.click('#office-pane .office-room[data-room="team:dev"] .office-room-pick[data-team="dev"]');
    await page.waitForSelector('#office-pane .office-room[data-room="team:dev"].active');
    assert.ok(mock.state.team.disabledAgents.includes("builder"), "dev's off-list names it again");
    assert.ok(await deskIn("dev").evaluate((el) => el.classList.contains("off")), "the dev seat is empty again");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("each desk paints its own team's duty, not another seat's", async () => {
    // `builder` is off duty on the inactive night team and on duty on the
    // running day team. Each desk must read its own roster row: the night seat
    // is empty, the day seat is staffed.
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        activeTeam: "day",
        teamsOrder: ["night", "day"],
        teams: {
          night: [{ name: "builder", active: false }],
          day: [{ name: "builder", active: true }],
        },
      }),
    });
    const podIn = (room) => page.locator(`#office-pane .office-room[data-room="team:${room}"] .office-pod[data-key="builder"]`);
    await podIn("day").waitFor();
    assert.ok(await podIn("night").evaluate((el) => el.classList.contains("leave")), "the off-duty night seat is empty");
    assert.ok(!(await podIn("day").evaluate((el) => el.classList.contains("leave"))), "the on-duty day seat is staffed");
    assert.match(await podIn("day").locator(".office-act.duty").textContent(), /off duty/i, "the day seat offers to go off duty");
    assert.match(await podIn("night").locator(".office-act.duty").textContent(), /on duty/i, "the night seat offers to come back");

    // Clicking the running seat's duty reads THAT seat's state (night is off,
    // day is on): day goes off duty and the already-off night seat is untouched.
    await podIn("day").locator(".office-act.duty").click();
    await until(() => (mock.state.team.teams.day || []).some((m) => m.name === "builder" && m.active === false), "the day seat goes off duty");
    assert.equal((mock.state.team.teams.night || []).find((m) => m.name === "builder").active, false, "the night seat is untouched");
    await page.waitForSelector('#office-pane .office-room[data-room="team:day"] .office-pod[data-key="builder"].leave');
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the hover popup reports the seat it is anchored to", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" })],
      team: defaultTeam({
        activeTeam: "day",
        teamsOrder: ["night", "day"],
        teams: {
          night: [{ name: "builder", active: false }],
          day: [{ name: "builder", active: true }],
        },
      }),
    });
    const podIn = (room) => page.locator(`#office-pane .office-room[data-room="team:${room}"] .office-pod[data-key="builder"]`);
    await podIn("day").waitFor();

    // The dormant night seat reports off duty…
    await podIn("night").hover();
    await page.waitForFunction(() => /Off duty/.test(document.getElementById("office-pop")?.textContent || ""), null, { timeout: 10_000 });

    // …while the running day seat reports the agent's real status.
    await podIn("day").hover();
    await page.waitForFunction(() => {
      const t = document.getElementById("office-pop")?.textContent || "";
      return /Working/.test(t) && !/Off duty/.test(t);
    }, null, { timeout: 10_000 });
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a subagent can be given a display name while keeping its real one", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "file_reader" })],
      team: defaultTeam({ teamsOrder: ["dev"], teams: { dev: [{ name: "file_reader" }] } }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="file_reader"]');

    const plate = () => pod("file_reader").locator(".office-plate");
    assert.match(await plate().textContent(), /file_reader/, "the desk starts with the real name");
    assert.equal(await plate().locator(".office-realname").count(), 0, "no separate real name yet");

    // The name is edited in the desk's settings popup, beside the model.
    await pod("file_reader").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    assert.equal(await page.locator("#office-settings-backdrop .office-set-name").count(), 1, "the popup carries the name field");
    await page.fill("#office-set-name", "Bob");
    await page.click("#office-settings-backdrop .office-set-name-save");
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-pod[data-key="file_reader"] .office-name')?.textContent === "Bob",
    );

    assert.equal(mock.state.team.teams.dev[0].displayName, "Bob", "the display name was saved to teams.yaml");
    const text = await plate().textContent();
    assert.match(text, /Bob/, "the desk shows the display name");
    assert.match(text, /file_reader/, "the real name stays beside it");
    assert.match(await pod("file_reader").getAttribute("title"), /Bob/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("teams are added and removed from the orchestrator's Teams manager", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // Team management lives with the orchestrator — the header no longer has it.
    assert.equal(await page.locator("#office-pane #office-newteam").count(), 0, "the header no longer creates teams");
    await page.click('#office-pane #office-teams-open');
    await page.waitForSelector("#office-teams-backdrop");
    // The manager opens listing every team on the roster.
    assert.deepEqual(
      await page.locator("#office-teams-backdrop .office-team-name").allTextContents(),
      ["dev", "review"],
      "the manager lists the teams",
    );

    // Add: the new team lands on the floor, active, with no desks yet.
    await page.fill("#office-teams-backdrop #office-team-new", "night_shift");
    await page.click("#office-teams-backdrop .office-lib-add-btn");
    await page.waitForSelector('#office-pane .office-room[data-room="team:night_shift"]');
    assert.ok(mock.state.team.teamsOrder.includes("night_shift"), "the server created the team");
    assert.equal(mock.state.team.activeTeam, "night_shift", "the new team is the active one");
    const room = page.locator('#office-pane .office-room[data-room="team:night_shift"]');
    assert.ok(await room.evaluate((el) => el.classList.contains("active")), "the new room is marked active");
    assert.equal(await room.locator(".office-pod").count(), 0, "the new team has no desks yet");
    assert.match(await room.locator(".office-room-meta").textContent(), /0\s*desks?/);
    assert.equal(await page.inputValue("#office-teams-backdrop #office-team-new"), "", "the field is cleared for the next team");
    assert.equal(
      await page.locator('#office-teams-backdrop .office-team-row[data-team="night_shift"]').count(),
      1,
      "the manager lists the new team",
    );

    // Remove: the team's room leaves the floor and its row leaves the manager.
    await page.click('#office-teams-backdrop .office-team-row[data-team="review"] .office-team-del');
    await page.waitForFunction(() => !document.querySelector('#office-pane .office-room[data-room="team:review"]'));
    assert.equal(mock.state.team.teams.review, undefined, "the server removed the team");
    assert.equal(
      await page.locator('#office-teams-backdrop .office-team-row[data-team="review"]').count(),
      0,
      "and the manager dropped its row",
    );

    // Escape closes the manager, as it does the other surfaces.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#office-teams-backdrop", { state: "detached" });
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the meeting room draws the library as a shelf, and it opens full-screen", async () => {
    const ref = `${WS}/docs/arch.md`;
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        teamsOrder: ["dev", "review"],
        teams: {
          dev: [{ name: "orchestrator" }, { name: "builder" }, { name: "critic" }],
          review: [{ name: "builder" }],
        },
        library: [
          { id: "lib_1", path: ref, note: "the API map", target: "builder" },
          { id: "lib_2", path: `${WS}/docs/` },
        ],
      }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // The library is a drawn shelf in the meeting room — not an inline form.
    const meeting = page.locator('#office-pane .office-room[data-room="meeting"]');
    const shelf = meeting.locator("#office-library-open");
    assert.equal(await shelf.count(), 1, "the meeting room holds the shelf");
    assert.equal(await page.locator("#office-pane #office-library-open").count(), 1, "and nowhere else");
    assert.ok((await shelf.locator("svg").count()) >= 1, "the shelf is an SVG");
    assert.ok((await shelf.locator("svg rect").count()) >= 10, "drawn books, not an icon font");
    assert.equal(await shelf.locator(".office-library-badge").textContent(), "2", "the badge counts the references");
    assert.match(await shelf.textContent(), /library/i);
    // The room holds the shelf alone — the form lives in the manager, not on the
    // carpet (the only other input on the view is the header's "+ team").
    assert.equal(await meeting.locator("input, select").count(), 0, "no library form is drawn in the room");
    // The floor holds no text fields at all: teams are managed from the
    // orchestrator's Teams manager, not an input in the header.
    assert.equal(await page.locator("#office-pane input").count(), 0, "the floor holds no forms");

    // Clicking it opens the full-screen manager over the whole viewport.
    await shelf.click();
    await page.waitForSelector("#office-lib-backdrop");
    const panel = await page.locator("#office-lib-backdrop .office-lib-panel").boundingBox();
    const view = page.viewportSize();
    // A roomy full-screen surface, not a cramped popup: it takes nearly the
    // whole viewport, leaving one reference per comfortable row.
    assert.ok(panel.width >= 1100, `the manager is a wide surface (${panel.width}px of ${view.width})`);
    assert.ok(panel.height >= view.height - 60, `and takes the full height (${panel.height}px of ${view.height})`);
    const row = await page.locator("#office-lib-backdrop .office-lib-row").first().boundingBox();
    assert.ok(row.height >= 40, `rows are not cramped (${row.height}px)`);
    const note = await page.locator("#office-lib-backdrop .office-lib-note").first().boundingBox();
    assert.ok(note.width >= 200, `the note field has room (${note.width}px)`);
    assert.match(await page.locator("#office-lib-backdrop .office-lib-hd-title").textContent(), /Reference library/);
    assert.match(await page.locator("#office-lib-backdrop .office-lib-hd-sub").textContent(), /injected at the start of every new conversation/);
    assert.ok(await page.locator("#office-lib-backdrop").evaluate((el) => getComputedStyle(el).position === "fixed"), "it is an overlay");
    assert.deepEqual(
      await page.locator("#office-lib-backdrop .office-lib-row .office-lib-path").allTextContents(),
      ["alpha/docs/", "alpha/docs/arch.md"],
      "every reference is listed, relative to the workspace, whole team first",
    );
    const rowOf = (id) => page.locator(`#office-lib-backdrop .office-lib-row[data-id="${id}"]`);
    assert.equal(await rowOf("lib_1").locator(".office-lib-note").inputValue(), "the API map");
    assert.equal(await rowOf("lib_1").locator(".office-lib-target").inputValue(), "builder", "the row names the agent it is for");
    assert.equal(await rowOf("lib_2").locator(".office-lib-target").inputValue(), "", "unassigned reads as the whole team");

    // The picker offers the whole team, then the roster's agents.
    const options = await page.locator("#office-lib-backdrop .office-lib-target option").allTextContents();
    assert.equal(options[0], "whole team");
    for (const who of ["orchestrator", "builder", "critic"]) assert.ok(options.includes(who), `${who} is assignable`);

    // Escape closes it.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#office-lib-backdrop", { state: "detached" });
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("references are added, reassigned and removed from the full-screen manager", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        teams: { dev: [{ name: "orchestrator" }, { name: "builder" }], review: [{ name: "critic" }] },
        library: [{ id: "lib_1", path: `${WS}/docs/arch.md`, note: "the API map" }],
      }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    await page.click("#office-library-open");
    await page.waitForSelector("#office-lib-backdrop");

    const rows = () => page.locator("#office-lib-backdrop .office-lib-row");

    // Add: path + note + the agent it is for, all in one go.
    await page.fill("#office-lib-backdrop #office-lib-path", "src/app.ts");
    await page.fill("#office-lib-backdrop #office-lib-note", "entry point");
    await page.selectOption("#office-lib-backdrop #office-lib-target", "builder");
    await page.click("#office-lib-backdrop .office-lib-add-btn");
    await page.waitForFunction(() => document.querySelectorAll("#office-lib-backdrop .office-lib-row").length === 2);
    const added = mock.state.team.library.find((e) => e.path === "src/app.ts");
    assert.ok(added, "the server stored the new reference");
    assert.equal(added.note, "entry point");
    assert.equal(added.target, "builder");
    assert.equal(await page.inputValue("#office-lib-backdrop #office-lib-path"), "", "the path field is cleared for the next one");
    assert.equal(await page.locator("#office-lib-backdrop .office-lib-row .office-lib-path").first().getAttribute("title"), `${WS}/docs/arch.md`, "the full path rides in the tooltip");
    assert.equal(await page.locator("#office-pane .office-library-badge").textContent(), "2", "the shelf badge follows");

    // Reassign: the picker on the row moves the reference to another agent.
    const row = page.locator(`#office-lib-backdrop .office-lib-row[data-id="lib_1"]`);
    await row.locator(".office-lib-target").selectOption("orchestrator");
    await page.waitForFunction(() =>
      document.querySelector('#office-lib-backdrop .office-lib-row[data-id="lib_1"] .office-lib-target')?.value === "orchestrator",
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#office-lib-backdrop .office-lib-row")].length === 2,
    );
    const moved = mock.state.team.library.find((e) => e.id === "lib_1");
    assert.equal(moved.target, "orchestrator", "the server saved the new target");

    // A note edit saves once it is committed.
    const first = rows().first();
    await first.locator(".office-lib-note").fill("the brief");
    await first.locator(".office-lib-note").blur();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#office-lib-backdrop .office-lib-note")].some((i) => i.value === "the brief"),
    );

    // Remove: only that row leaves.
    await rows().first().locator(".office-lib-del").click();
    await page.waitForFunction(() => document.querySelectorAll("#office-lib-backdrop .office-lib-row").length === 1);
    assert.equal(mock.state.team.library.length, 1);

    // Empty it and the manager says so; the shelf keeps its form with a 0 badge.
    await rows().first().locator(".office-lib-del").click();
    await page.waitForSelector("#office-lib-backdrop .office-lib-none");
    assert.match(await page.locator("#office-lib-backdrop .office-lib-none").textContent(), /No references yet/);
    assert.equal(await page.locator("#office-pane .office-library-badge").textContent(), "0");
    assert.equal(await page.locator("#office-pane #office-library-open svg").count(), 1, "the shelf stays");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a subagent's markdown definition opens, saves and closes from its desk", async () => {
    const content = "---\nname: builder\ndescription: Builds things\n---\n\nYou are a builder.\n";
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      defs: [{ file: "builder.md", name: "builder", description: "Builds things", model: "", tools: "", thinking: "", content }],
    });

    // The definition is opened from the desk's settings popup.
    await pod("builder").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.click("#office-settings-backdrop .office-set-md");
    const ta = page.locator("#office-md-backdrop .def-editor-text");
    await ta.waitFor({ state: "visible" });
    assert.equal(await ta.inputValue(), content, "the whole file opens, frontmatter included");

    const next = "---\nname: builder\ndescription: Rewritten\n---\n\nDo it differently.\n";
    await ta.fill(next);
    await page.click("#office-md-backdrop .def-editor-save");
    await page.waitForSelector("#office-md-backdrop", { state: "detached" });

    assert.equal(mock.state.agentDefs.find((d) => d.file === "builder.md").content, next, "the edit was written back");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the plan reads: orchestrator top-left, meeting room to its right, teams two-left / two-right of the pathway", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: fourTeams(),
    });
    await page.waitForSelector('#office-pane .office-room[data-room="team:docs"]');

    const box = async (sel) => {
      const b = await page.locator(`#office-pane ${sel}`).boundingBox();
      assert.ok(b, `${sel} is laid out`);
      return b;
    };
    const plan = await box(".office-plan");
    const center = plan.x + plan.width / 2;

    // The orchestrator's office is on top, the meeting room beside it to its right.
    const orch = await box('.office-room[data-room="orchestrator"]');
    const meeting = await box('.office-room[data-room="meeting"]');
    assert.ok(Math.abs(orch.y - meeting.y) < 6, "the orchestrator's office and the meeting room share the top row");
    assert.ok(meeting.x > orch.x + orch.width - 2, "the meeting room sits to the right of the orchestrator");

    // The orchestrator's office is above every team room.
    for (const t of ["dev", "review", "ops", "docs"]) {
      const b = await box(`.office-room[data-room="team:${t}"]`);
      assert.ok(b.y >= orch.y + orch.height - 2, `the ${t} room is below the orchestrator's office`);
    }

    // Team rooms split two-left / two-right of the center pathway.
    const left = await box('.office-room[data-room="team:dev"]');
    const right = await box('.office-room[data-room="team:review"]');
    const left2 = await box('.office-room[data-room="team:ops"]');
    const right2 = await box('.office-room[data-room="team:docs"]');
    assert.ok(left.x + left.width < center, "the first team room is left of the pathway");
    assert.ok(right.x > center, "the second team room is right of the pathway");
    assert.ok(left2.x + left2.width < center, "the third team room is left of the pathway");
    assert.ok(right2.x > center, "the fourth team room is right of the pathway");
    assert.ok(right.x - (left.x + left.width) > 20, "there is a center pathway between the columns");

    // The pathway is really drawn, not just a gap: a corridor in the middle.
    const pathway = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector("#office-pane .office-plan"), "::before");
      return { content: cs.content, width: parseFloat(cs.width) };
    });
    assert.notEqual(pathway.content, "none", "the plan draws a center pathway");
    assert.ok(pathway.width > 10, `the pathway has width (${pathway.width})`);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the room is dressed: carpet, wooden desks, windows, plants and armchairs", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // The furniture the floor plan calls for is actually part of the room.
    const dressing = await page.evaluate(() => {
      const south = document.querySelector("#office-pane .office-wall-south");
      return {
        windows: document.querySelectorAll("#office-pane .office-window").length,
        plants: document.querySelectorAll("#office-pane .office-plant").length,
        armchairs: document.querySelectorAll("#office-pane .office-armchair").length,
        southBorder: south ? parseFloat(getComputedStyle(south).borderTopWidth) : 0,
        meetingSeats: document.querySelectorAll("#office-pane .office-room[data-room='meeting'] .office-seat").length,
      };
    });
    assert.ok(dressing.windows >= 1, "the outer wall has windows");
    assert.ok(dressing.plants >= 3, `the floor is planted (${dressing.plants})`);
    assert.equal(dressing.armchairs, 2, "armchairs line the south wall");
    assert.ok(dressing.southBorder > 0, "a south wall closes the room off");
    assert.equal(dressing.meetingSeats, 4, "the meeting table keeps its four armchairs");

    // The room is painted from the office palette, not from the UI theme's
    // tokens — so it keeps its own look in both themes.
    const paint = await page.evaluate(() => {
      // Read the tokens the *element* inherits (the dark theme overrides live on
      // <body>, not <html>), and turn them into the same rgb() form the browser
      // uses in a computed background.
      const toRgb = (value) => {
        const probe = document.createElement("span");
        probe.style.color = value;
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color;
        probe.remove();
        return rgb;
      };
      const plan = document.querySelector("#office-pane .office-plan");
      const desk = document.querySelector("#office-pane .office-desk");
      const token = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
      return {
        floor: toRgb(token(plan, "--office-floor")),
        wood: toRgb(token(desk, "--office-wood-top")),
        carpet: getComputedStyle(plan).backgroundColor,
        desk: getComputedStyle(desk).backgroundImage,
      };
    });
    assert.equal(paint.carpet, paint.floor, "the carpet paints the office floor colour");
    assert.ok(paint.desk.includes(paint.wood), `the desk is wood (${paint.desk} vs ${paint.wood})`);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the room's header is name-left / actions-right, and the cubicle's is name then its own controls", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" }),
        makeSession({ session_id: "s2", cwd: WS, agent_name: "critic" }),
      ],
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    const box = async (sel) => {
      const b = await page.locator(`#office-pane ${sel}`).first().boundingBox();
      assert.ok(b, `${sel} is laid out`);
      return b;
    };

    // The team room: its name at the top-left, its activate badge at the
    // top-right. Hiring moved into the orchestrator's settings popup.
    const room = await box('.office-room[data-room="team:dev"]');
    const rName = await box('.office-room[data-room="team:dev"] .office-room-name');
    const rActive = await box('.office-room[data-room="team:dev"] .office-room-active');
    const mid = room.x + room.width / 2;
    assert.ok(rName.x + rName.width < mid, "the team's name sits in the room's left half");
    assert.ok(rName.y < room.y + room.height / 3, "the name is in the room's top band");
    assert.ok(rActive.x > mid && rActive.x + rActive.width <= room.x + room.width, "the active badge is at the top-right");
    assert.equal(await page.locator('#office-pane .office-room[data-room="team:dev"] .office-hire').count(), 0, "the room header no longer hires");

    // An inactive team shows its Activate control in the same place.
    const pick = await box('.office-room[data-room="team:review"] .office-room-pick');
    assert.ok(pick.x > room.x + room.width, "activate sits at the right of its own room too");
    assert.match(await page.locator('#office-pane .office-room[data-room="team:review"] .office-room-pick').textContent(), /activate/i);

    // The cubicle: the name at its top-left, then off duty / settings beneath it.
    const pod = await box('.office-pod[data-key="builder"]');
    const pName = await box('.office-pod[data-key="builder"] .office-name');
    const station = await box('.office-pod[data-key="builder"] .office-station');
    const duty = await box('.office-pod[data-key="builder"] .office-act.duty');
    const settings = await box('.office-pod[data-key="builder"] .office-act[data-act="settings"]');
    assert.ok(pName.x < pod.x + pod.width / 2, "the subagent's name is at the cubicle's top-left");
    assert.ok(pName.y < station.y, "the name sits above the desk");
    for (const [what, b] of [["off duty", duty], ["settings", settings]]) {
      assert.ok(b.y < station.y, `${what} is in the cubicle's top band, above the desk`);
      assert.ok(b.x >= pod.x && b.x + b.width <= pod.x + pod.width, `${what} is inside the cubicle`);
    }
    assert.ok(duty.x < settings.x, "the controls run off duty → settings");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the floor's labels and controls stay legible on the carpet in both themes", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" }),
        makeSession({ session_id: "s2", cwd: WS, agent_name: "critic" }),
      ],
      team: defaultTeam({
        // Duty is per team: `critic` sits on the inactive `review` team, so its
        // own roster row carries the off-duty flag (the session-wide
        // `disabledAgents` list only silences the team that is running).
        teams: {
          dev: [
            { name: "orchestrator", model: "google/gemini-2.5-flash-lite", active: true },
            { name: "builder", model: "google/gemini-2.5-flash-lite", active: true },
          ],
          review: [{ name: "critic", model: "google/gemini-2.5-flash-lite", active: false }],
        },
        library: [{ id: "lib_1", path: `${WS}/docs/arch.md`, note: "the API map" }],
      }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // WCAG contrast of each label against what is actually behind it: the
    // element's own background composited over the carpet. Canvas does the
    // colour maths, so `color(srgb …)`, rgba() and colour-mix all resolve.
    const measure = () => page.evaluate(() => {
      const plan = document.querySelector("#office-pane .office-plan");
      const px = (color, under) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const g = c.getContext("2d");
        if (under) { g.fillStyle = under; g.fillRect(0, 0, 1, 1); }
        g.fillStyle = color;
        g.fillRect(0, 0, 1, 1);
        return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const lum = ([r, g, b]) => {
        const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const carpet = getComputedStyle(plan).backgroundColor;
      const ratioOf = (el) => {
        const cs = getComputedStyle(el);
        const bg = px(cs.backgroundColor, carpet);
        const fg = px(cs.color, `rgb(${bg.join(",")})`);
        const a = lum(fg), b = lum(bg);
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      };
      const q = (s) => document.querySelector(`#office-pane ${s}`);
      const targets = {
        "active team name": '.office-room[data-room="team:dev"] .office-room-name',
        "idle team name": '.office-room[data-room="team:review"] .office-room-name',
        "orchestrator name": '.office-room[data-room="orchestrator"] .office-room-name',
        "team meta": '.office-room[data-room="team:dev"] .office-room-meta',
        "cubicle name": '.office-pod[data-key="builder"] .office-name',
        "activity label": '.office-pod[data-key="builder"] .office-bubble',
        "off-duty tag": '.office-pod[data-key="critic"] .office-leave-tag',
        "off duty button": '.office-pod[data-key="builder"] .office-act.duty',
        "settings button": '.office-pod[data-key="builder"] .office-act[data-act="settings"]',
        "model label": '.office-pod[data-key="builder"] .office-model-label',
        "active badge": '.office-room[data-room="team:dev"] .office-room-active',
        "activate button": '.office-room[data-room="team:review"] .office-room-pick',
        "library label": ".office-library-label",
        "library badge": ".office-library-badge",
      };
      const out = {};
      for (const [what, sel] of Object.entries(targets)) {
        const el = q(sel);
        out[what] = el ? ratioOf(el) : -1;
      }
      return out;
    });

    const dark = await measure();
    for (const [what, ratio] of Object.entries(dark)) {
      assert.ok(ratio >= 4.5, `${what} on the carpet (dark): ${ratio}:1`);
    }

    // The office tokens for the light theme live on :root, so dropping the dark
    // attribute repaints the same floor — no reload needed.
    await page.evaluate(() => document.body.removeAttribute("data-ds-dark-theme"));
    const light = await measure();
    for (const [what, ratio] of Object.entries(light)) {
      assert.ok(ratio >= 4.5, `${what} on the carpet (light): ${ratio}:1`);
    }
    // The two themes really are different floors, so this was not a no-op.
    assert.notDeepEqual(dark, light, "the palette changed with the theme");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("each cubicle holds a desk, a screen, a chair and a seated agent", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
    });
    const box = await pod("builder").boundingBox();
    assert.ok(box && box.width > 120 && box.height > 120, "the cubicle is a real plot, not a bare label");

    // Furniture, each rendered inside the cubicle plot.
    for (const sel of [".office-station", ".office-desk", ".office-monitor", ".office-keyboard", ".office-chair", ".office-person"]) {
      assert.equal(await pod("builder").locator(sel).count(), 1, `${sel} is drawn once`);
    }
    // The agent sits in the cubicle, in front of a screen on the desk.
    const [person, monitor, chair] = await Promise.all([
      pod("builder").locator(".office-person").boundingBox(),
      pod("builder").locator(".office-monitor").boundingBox(),
      pod("builder").locator(".office-chair").boundingBox(),
    ]);
    assert.ok(person.y > monitor.y, "the agent faces the screen from below (top-down)");
    assert.ok(chair.y >= monitor.y, "the chair sits behind the desk");

    // The partition walls are the three visible borders of the cubicle.
    const borders = await pod("builder").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { top: cs.borderTopWidth, left: cs.borderLeftWidth, right: cs.borderRightWidth, bottom: cs.borderBottomWidth };
    });
    assert.ok(parseFloat(borders.top) > 0 && parseFloat(borders.left) > 0 && parseFloat(borders.right) > 0, "three partition walls");

    // The orchestrator gets the manager's cubicle, marked as such.
    assert.ok(await pod("orchestrator").evaluate((el) => el.classList.contains("orch")), "orchestrator cubicle is marked");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a working agent's screen animates; an idle one's does not", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" }),
      ],
    });
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-pod[data-key="builder"]')?.classList.contains("working"),
    );

    const anim = (key, sel) => page.evaluate(([k, s]) => {
      const el = document.querySelector(`#office-pane .office-pod[data-key="${k}"] ${s}`);
      return el ? getComputedStyle(el).animationName : null;
    }, [key, sel]);

    // The screen has code lines, and they run while the agent works…
    assert.equal(await pod("builder").locator(".office-code i").count(), 3, "the screen holds code lines");
    const names = await page.evaluate(() => {
      const el = document.querySelector('#office-pane .office-pod[data-key="builder"] .office-code');
      return [...el.children].map((i) => getComputedStyle(i).animationName);
    });
    assert.ok(names.every((n) => n !== "none"), `all code lines animate while working (${names})`);
    assert.notEqual(await anim("builder", ".office-monitor"), null);

    // …and the idle orchestrator's screen stays still.
    const idle = await page.evaluate(() => {
      const el = document.querySelector('#office-pane .office-pod[data-key="orchestrator"] .office-code');
      return [...el.children].map((i) => getComputedStyle(i).animationName);
    });
    assert.ok(idle.every((n) => n === "none"), `idle code lines do not animate (${idle})`);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a subagent taken off duty has an empty desk", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder" }),
        makeSession({ session_id: "s2", cwd: WS, agent_name: "critic", last_turn_event: "turn_start" }),
      ],
      // Off duty on the member's OWN row (the inactive `review` team), which
      // is where per-team duty lives now.
      team: defaultTeam({
        teams: {
          dev: [
            { name: "orchestrator", model: "google/gemini-2.5-flash-lite", active: true },
            { name: "builder", model: "google/gemini-2.5-flash-lite", active: true },
          ],
          review: [{ name: "critic", model: "google/gemini-2.5-flash-lite", active: false }],
        },
      }),
    });
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-pod[data-key="critic"]')?.classList.contains("leave"),
    );

    assert.ok(await pod("critic").evaluate((el) => el.classList.contains("leave")), "the pod shows the off-duty state");
    assert.equal(await pod("critic").evaluate((el) => el.classList.contains("working")), false, "a disabled agent is never working");
    assert.match(await page.textContent('#office-pane .office-pod[data-key="critic"] .office-leave-tag'), /off duty/i);
    assert.ok(await pod("critic").locator(".office-leave-tag").isVisible(), "the plate says Off duty");
    assert.equal(await pod("critic").locator(".office-person").isVisible(), false, "nobody is sitting at the desk");
    // The tooltip carries the same state (lower-case, like the other activities).
    assert.match(await pod("critic").getAttribute("title"), /off duty/i);
    assert.match(await counts(), /1\s*off duty/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a turn_end flips the desk from working to waiting", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" }),
      ],
    });
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-pod[data-key="builder"]')?.classList.contains("working"),
    );

    // The agent finishes its turn; the office must stop the typing animation.
    await page.evaluate(() => {
      const s = window.__SCOPE_STATE.sessions.find((x) => x.agent_name === "builder");
      if (s) s.last_turn_event = "turn_end";
      window.__officeOnSessions?.();
    });
    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-pod[data-key="builder"]')?.classList.contains("waiting"),
    );
    assert.equal(await pod("builder").evaluate((el) => el.classList.contains("working")), false);
  });

  test("a live tool call labels what the agent is doing", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" }),
      ],
    });

    // Wait for the SSE stream to be live, then push an event for that agent.
    await page.waitForFunction(() => document.getElementById("live-dot")?.classList.contains("green"), { timeout: 10_000 });
    mock.broadcastSSE({
      event_id: "ev-1",
      session_id: SID,
      seq: 1,
      ts: new Date().toISOString(),
      type: "tool_call",
      agent_name: "builder",
      pool: "chat",
      payload: { tool_name: "bash" },
    });

    await page.waitForFunction(() =>
      document.querySelector('#office-pane .office-pod[data-key="builder"] .office-bubble')?.textContent.includes("bash"),
      { timeout: 10_000 },
    );
  });

  test("hovering a cubicle pops up that agent's recent messages", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder", last_turn_event: "turn_start" })],
      events: {
        [SID]: agentEvents([
          { type: "user_message", payload: { text: "make the office look real" } },
          { type: "tool_call", payload: { tool_name: "bash", args: { command: "npm test" } } },
          { type: "tool_result", payload: { tool_name: "bash", content_text: "109 tests passed", is_error: false } },
          { type: "assistant_message", payload: { text: "All green — shipping it." } },
        ]),
      },
    });

    // Nothing is shown until the pointer is over a cubicle.
    assert.equal(await page.locator("#office-pop").isHidden(), true, "no popup before hover");

    await pod("builder").hover();
    await page.waitForSelector("#office-pop:not([hidden])", { timeout: 10_000 });
    await page.waitForFunction(() =>
      document.getElementById("office-pop")?.textContent.includes("All green"),
    );

    const text = await page.textContent("#office-pop");
    assert.match(text, /builder/, "names the agent");
    assert.match(text, /subagent/, "says which seat it holds");
    assert.match(text, /\$ bash npm test/, "shows the tool call as a command line");
    assert.match(text, /✓ bash {2}109 tests passed/, "shows the tool result");
    assert.match(text, /All green — shipping it\./, "shows the agent's reply");
    assert.match(await counts(), /1\s*working/);

    // Moving off the cubicle closes it again.
    await page.mouse.move(4, 4);
    await page.waitForFunction(() => document.getElementById("office-pop")?.hidden === true);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("an office with no agents shows the empty state", async () => {
    await boot({
      sessions: [],
      team: defaultTeam({ activeTeam: "solo", teamsOrder: ["solo"], teams: { solo: [] } }),
    });
    // Only the orchestrator desk, and it has never run.
    await page.waitForSelector('#office-pane .office-pod[data-key="orchestrator"]');
    await page.waitForFunction(() => document.getElementById("office-empty")?.hidden === false);
    await sleep(50);
    assert.equal(await page.locator("#office-pane .office-pod").count(), 1);
  });

  test("the office can be named from the wall", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // An office nobody has named reads as "Office"; clicking the title opens the
    // one-field form that renames it.
    const title = page.locator("#office-name");
    assert.equal(await title.textContent(), "Office", "an unnamed office reads as Office");
    await title.click();
    await page.waitForSelector("#office-dlg-backdrop");
    assert.equal(await page.inputValue("#office-name-input"), "", "the field starts empty for an unnamed office");
    await page.fill("#office-name-input", "  Night   Shift HQ  ");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForSelector("#office-dlg-backdrop", { state: "detached" });

    // The write lands in the roster, the header follows, and it is one write.
    assert.equal(mock.officeState().officeName, "Night Shift HQ", "the server stored the name");
    await page.waitForFunction(() => document.getElementById("office-name")?.textContent === "Night Shift HQ");
    const writes = mock.requestsFor("/office", "POST").filter((r) => r.body.action === "setOfficeName");
    assert.equal(writes.length, 1, "renaming is a single roster write");

    // It hangs on the north wall, right of the window and left of the clock.
    const name = await title.boundingBox();
    const wall = await page.locator("#office-pane .office-wall").first().boundingBox();
    const win = await page.locator("#office-pane .office-wall .office-window").boundingBox();
    const clock = await page.locator("#office-pane .office-wall .office-clock").boundingBox();
    assert.ok(name.y >= wall.y && name.y + name.height <= wall.y + wall.height, "the name hangs on the wall");
    assert.ok(name.x >= win.x + win.width - 1, "it sits right of the window and plant");
    assert.ok(name.x + name.width <= clock.x + 1, "and left of the clock");
    assert.equal(await page.locator("#office-pane .office-title").count(), 1, "the name is the view's own title");
    assert.equal(await page.locator("#office-pane .office-header .office-title").count(), 0, "and no longer sits in the pane header");

    // Reopening offers the current name; saving it empty restores the default.
    await title.click();
    await page.waitForSelector("#office-name-input");
    assert.equal(await page.inputValue("#office-name-input"), "Night Shift HQ", "the field holds the current name");
    await page.fill("#office-name-input", "");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForFunction(() => document.getElementById("office-name")?.textContent === "Office");
    assert.equal(mock.officeState().officeName, undefined, "clearing the name drops it from the plugin's store");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the orchestrator's desk carries a model picker", async () => {
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" }),
        makeSession({ session_id: "s2", cwd: WS, agent_name: "builder" }),
      ],
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="orchestrator"]');

    // The corner office owns the default-model picker; a subagent's own picker
    // (see the test below) writes its team row instead, so it never carries
    // this one.
    const pick = pod("orchestrator").locator("#office-orch-model");
    assert.equal(await pick.count(), 1, "the orchestrator's desk carries a model picker");
    assert.equal(await pick.isVisible(), true, "and it is drawn on the desk");
    assert.equal(await pod("builder").locator("#office-orch-model").count(), 0, "a subagent's desk has none");
    assert.equal(await page.locator("#office-pane .office-orch-model").count(), 1, "there is exactly one on the floor");
    assert.match(await pick.getAttribute("aria-label"), /orchestrator/i);

    // Every known model, grouped one provider per <optgroup> (like Settings),
    // with the app's current default selected.
    const groups = await pick.locator("optgroup").evaluateAll((els) => els.map((e) => e.label));
    assert.deepEqual(groups, ["anthropic", "deepseek", "google"], "a group per provider, sorted");
    assert.equal(await pick.inputValue(), "google/gemini-2.5-flash-lite", "the current default model is selected");
    const values = await pick.locator("option").evaluateAll((els) => els.map((e) => e.value));
    for (const m of ["google/gemini-2.5-flash-lite", "deepseek/deepseek-v4-flash", "anthropic/claude-sonnet-4"]) {
      assert.ok(values.includes(m), `${m} is offered`);
    }
    assert.ok(
      (await pick.locator('optgroup[label="anthropic"] option').allTextContents()).includes("claude-sonnet-4"),
      "options are labelled by id, without the provider prefix",
    );

    // Choosing one writes the app's default model, and the picker keeps it.
    await pick.selectOption("deepseek/deepseek-v4-flash");
    await until(() => mock.state.team.defaultModel === "deepseek/deepseek-v4-flash", "the default model is written");
    const wrote = mock.requestsFor("/settings", "POST").filter((r) => r.body.action === "setDefaultModel");
    assert.equal(wrote.length, 1, "the picker writes the default model");
    assert.equal(wrote[0].body.value, "deepseek/deepseek-v4-flash");
    await page.waitForFunction(() =>
      document.getElementById("office-orch-model")?.value === "deepseek/deepseek-v4-flash",
    );
    assert.equal(await page.inputValue("#office-orch-model"), "deepseek/deepseek-v4-flash", "and shows the choice");

    // The choice survives a reload — it was stored, not just drawn.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("office-orch-model")?.value === "deepseek/deepseek-v4-flash");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a subagent's desk carries its own model picker, under the worker, writing its team row", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({ teams: { dev: [{ name: "orchestrator" }, { name: "builder" }], review: [{ name: "critic" }] } }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // The picker and the totals live in the desk's foot — below the seated
    // worker, not up in its header.
    const foot = pod("builder").locator(".office-pod-foot");
    assert.equal(await foot.locator(".office-model-select").count(), 1, "the model picker is in the foot");
    assert.equal(await foot.locator(".office-stats").count(), 1, "and so are the totals");
    const person = await pod("builder").locator(".office-person").boundingBox();
    const footBox = await foot.boundingBox();
    assert.ok(footBox.y >= person.y, "the foot sits below the worker");

    // A member with no model reads as the team default; choosing one writes the
    // member's own teams.yaml row (the orchestrator's writes settings.json).
    const pick = pod("builder").locator(".office-model-select");
    assert.equal(await pick.getAttribute("data-model-for"), "member");
    assert.equal(await pick.inputValue(), "", "no model yet means the team default");
    await pick.selectOption("deepseek/deepseek-v4-flash");
    await until(() => (mock.state.team.teams.dev.find((m) => m.name === "builder") || {}).model === "deepseek/deepseek-v4-flash", "the member's model is written");
    const posts = mock.requestsFor("/agent-team", "POST").filter((r) => r.body.action === "setMemberModel");
    assert.equal(posts.length, 1, "the picker writes teams.yaml");
    assert.equal(posts[0].body.team, "dev", "scoped to the desk's own team");
    assert.equal(posts[0].body.agent, "builder");
    assert.equal(await page.locator("#office-pane .office-model-select").count(), 3, "every desk carries one");
    await page.waitForFunction(() => document.querySelector('#office-pane .office-pod[data-key="builder"] .office-model-select')?.value === "deepseek/deepseek-v4-flash");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the settings popup gathers skills, tools, extensions and duty, and writes them through", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        tools: ["bash", "read"],
        skills: [
          { name: "planner", dir: "planner", description: "plan things", orchestrator: true, subagent: false },
          { name: "reviewer", dir: "reviewer", description: "review things", orchestrator: false, subagent: true },
        ],
        extensions: [{ name: "agent-team", path: "/home/u/.pi/extensions/agent-team.ts", available: true, enabled: true }],
      }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    const popup = () => page.locator("#office-settings-backdrop");
    const on = (sel) => popup().locator(sel).evaluate((el) => el.classList.contains("on"));

    // A subagent's popup: extensions, duty, definition and fire. Skills and
    // tools are no longer roster toggles — a subagent's are its own
    // agents/<name>.md, and this fixture has no definition for builder.
    await pod("builder").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    assert.equal(await popup().locator("[data-set-skill]").count(), 0, "a subagent has no roster-level skill set");
    assert.equal(await popup().locator("[data-set-tool]").count(), 0, "tools are the orchestrator's");
    assert.equal(await popup().locator("[data-desk-skill]").count(), 0, "nor any pinned skills without a definition");
    assert.match(await popup().textContent(), /No agents\/builder\.md definition/, "which the panel says out loud");
    assert.equal(await popup().locator(".office-set-md").count(), 1, "the markdown definition is here");
    assert.equal(await popup().locator(".office-set-duty").count(), 1, "so is duty");
    assert.equal(await popup().locator(".office-set-fire").count(), 1, "and fire");

    // Extensions toggle from here, and the write goes to the roster.
    await popup().locator("[data-set-ext]").click();
    await until(() => mock.state.team.extensions[0].enabled === false, "the extension is disabled");

    // The orchestrator's popup carries tools and hire, and no fire / duty.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#office-settings-backdrop", { state: "detached" });
    await pod("orchestrator").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    assert.equal(await popup().locator("[data-set-tool]").count(), 2, "the orchestrator's tools are listed");
    assert.equal(await on('[data-set-tool="bash"]'), true, "an enabled tool reads as on");
    await popup().locator('[data-set-tool="bash"]').click();
    await until(() => (mock.state.team.skipOrchestratorTools || []).some((t) => String(t).toLowerCase() === "bash"), "the tool is skipped");

    // So do its skills: the roster-level set belongs to the orchestrator alone.
    assert.equal(await popup().locator("[data-set-skill]").count(), 2, "the orchestrator's skills are listed");
    assert.equal(await on('[data-set-skill="reviewer"]'), false, "one it has not turned on reads as off");
    await popup().locator('[data-set-skill="reviewer"]').click();
    await until(() => mock.state.team.skills.find((s) => s.dir === "reviewer").orchestrator === true, "the skill turns on for the orchestrator");
    assert.equal(await popup().locator(".office-set-hire").count(), 1, "the orchestrator hires from here");
    assert.equal(await popup().locator(".office-set-fire").count(), 0, "the orchestrator cannot be fired");
    assert.equal(await popup().locator(".office-set-duty").count(), 0, "and has no duty toggle");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a subagent's popup references its own agents/*.md skills and tools, and writes them through", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        tools: ["bash", "read", "grep"],
        skills: [
          { name: "planner", dir: "planner", description: "plan things", orchestrator: true, subagent: false },
          { name: "reviewer", dir: "reviewer", description: "review things", orchestrator: false, subagent: true },
        ],
      }),
      // builder.md pins its own skill and tool; critic.md carries neither key, so
      // it gets no skills and the default tool list.
      defs: [
        { file: "builder.md", name: "builder", skills: ["planner"], tools: ["read"], toolsAll: false,
          content: "---\nname: builder\nskills: planner\ntools: read\n---\n\nBuild.\n" },
        { file: "critic.md", name: "critic",
          content: "---\nname: critic\n---\n\nCritique.\n" },
      ],
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    const popup = () => page.locator("#office-settings-backdrop");
    const on = (sel) => popup().locator(sel).evaluate((el) => el.classList.contains("on"));

    await pod("builder").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.waitForSelector('#office-settings-backdrop [data-desk-tool="read"]');

    // The definition's OWN pickers: the md file pins planner + read, so those
    // read as on and everything else as off.
    assert.equal(await popup().locator("[data-desk-skill]").count(), 2, "every discovered skill is offered");
    assert.equal(await on('[data-desk-skill="planner"]'), true, "the md-pinned skill reads as on");
    assert.equal(await on('[data-desk-skill="reviewer"]'), false, "one it does not pin reads as off");
    assert.equal(await popup().locator("[data-desk-tool]").count(), 3, "every reported tool is offered");
    assert.equal(await on('[data-desk-tool="read"]'), true, "the md-pinned tool reads as on");
    assert.equal(await on('[data-desk-tool="bash"]'), false);

    // Clicking writes the definition file — not the roster — and repaints.
    await popup().locator('[data-desk-tool="bash"]').click();
    await until(() => {
      const d = mock.state.agentDefs.find((x) => x.file === "builder.md");
      return d && d.toolsAll === false && d.tools.includes("bash") && d.tools.length === 2;
    }, "the tool is written into agents/builder.md");
    await page.waitForFunction(() => document.querySelector('#office-settings-backdrop [data-desk-tool="bash"]')?.classList.contains("on"));
    assert.equal(
      mock.requestsFor("/settings", "POST").some((r) => r.body.action === "setAgentDefTools" && r.body.value.file === "builder.md"),
      true,
      "the write goes through setAgentDefTools",
    );
    // The roster is untouched: this is a file write, not a team toggle.
    assert.equal(
      mock.requestsFor("/agent-team", "POST").length,
      0,
      "nothing was written to teams.yaml / agent-team-config.json",
    );

    await popup().locator('[data-desk-skill="reviewer"]').click();
    await until(() => {
      const d = mock.state.agentDefs.find((x) => x.file === "builder.md");
      return d && d.skills.includes("reviewer") && d.skills.includes("planner");
    }, "the skill is written into agents/builder.md");

    // A definition with no allowlists gets none and falls back to the default
    // tool list — never an empty chip row.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#office-settings-backdrop", { state: "detached" });
    await pod("critic").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.waitForSelector('#office-settings-backdrop [data-desk-tool="read"]');
    assert.equal(await on('[data-desk-skill="reviewer"]'), false, "an absent skills: key pins nothing");
    assert.equal(await on('[data-desk-skill="planner"]'), false, "so no skill reads as on");
    assert.match(await popup().locator(".office-set-sec", { hasText: "Definition skills" }).locator(".office-set-sec-hint").textContent(), /0 pinned/);
    assert.equal(await on('[data-desk-tool="read"]'), true, "an absent tools: key uses the default tool list");
    assert.equal(await on('[data-desk-tool="grep"]'), true);
    assert.equal(await on('[data-desk-tool="bash"]'), false, "and nothing beyond it");
    assert.match(await popup().locator(".office-set-sec", { hasText: "Definition tools" }).locator(".office-set-sec-hint").textContent(), /default tool list/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("each desk shows the tokens it spent and what they cost", async () => {
    mock.setStats(SID, { total_tokens: 12_345, total_cost: 0.042, error_count: 0, models: ["google/gemini-2.5-flash-lite"] });
    await boot({
      sessions: [
        makeSession({ session_id: SID, cwd: WS, agent_name: "builder" }),
        makeSession({ session_id: "s2", cwd: WS, agent_name: "critic" }),
      ],
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // The office batches its desks' totals into one request, by session id.
    await page.waitForFunction(() =>
      (document.querySelector('#office-pane .office-pod[data-key="builder"] .office-stats')?.textContent || "").length > 0,
    );
    const fetched = mock.requestsFor("/sessions/stats", "GET");
    assert.ok(fetched.length >= 1, "the office asked the server for the desks' totals");
    assert.ok(fetched.some((r) => String(r.query.ids || "").includes(SID)), "builder's session is in the batch");

    // The line is the app's own token format plus the price.
    const tokens = await page.evaluate((n) => window.SCOPE.fmtTokens(n), 12_345);
    assert.equal(await pod("builder").locator(".office-stats").textContent(), `${tokens} tok · $0.042`);
    assert.equal(await pod("builder").locator(".office-stats").isVisible(), true, "the line is drawn under the desk");

    // A desk the server reports nothing for claims nothing.
    assert.equal(await pod("critic").locator(".office-stats").textContent(), "", "no totals, no line");
    assert.equal(await pod("critic").locator(".office-stats").isVisible(), false, "and it takes no room");

    // The numbers come from the server, not from anything baked into the page.
    mock.setStats(SID, { total_tokens: 20_000, total_cost: 1.5 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      (document.querySelector('#office-pane .office-pod[data-key="builder"] .office-stats')?.textContent || "").includes("20.0k"),
    );
    assert.equal(
      await pod("builder").locator(".office-stats").textContent(),
      `${await page.evaluate((n) => window.SCOPE.fmtTokens(n), 20_000)} tok · $1.50`,
      "a fresh fetch moves the desk's totals",
    );
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the meeting room carries the board, and the full board lays out four columns", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      office: {
        tasks: [
          { id: "t1", title: "draft the plan", status: "todo", createdAt: 1 },
          { id: "t2", title: "ship it", status: "done", createdAt: 2, finishedAt: 3 },
        ],
      },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // The board hangs in the meeting room: one sign, with a count per column.
    const sign = page.locator("#office-board-open");
    assert.equal(await sign.count(), 1, "the meeting room carries the board");
    const meeting = await page.locator('#office-pane .office-room[data-room="meeting"]').boundingBox();
    const signBox = await sign.boundingBox();
    assert.ok(signBox.x >= meeting.x && signBox.x + signBox.width <= meeting.x + meeting.width, "the sign sits inside the meeting room");
    assert.ok(signBox.y >= meeting.y && signBox.y + signBox.height <= meeting.y + meeting.height, "and within its walls");
    assert.equal(await page.locator("#office-pane .office-wall #office-board-open").count(), 0, "the north wall no longer carries it");
    assert.match(await sign.locator(".office-kanban-head").textContent(), /kanban/i);
    // It shares the room with the meeting table and the reference library.
    const table = await page.locator('#office-pane .office-room[data-room="meeting"] .office-roundtable').boundingBox();
    assert.ok(signBox.x >= table.x + table.width - 2, "the board sits beside the meeting table");
    assert.equal(await page.locator('#office-pane .office-room[data-room="meeting"] #office-library-open').count(), 1, "and the shelf shares the room");
    assert.deepEqual(
      await sign.locator(".office-kmini-col").allTextContents(),
      ["Todo1", "Planned0", "In Progress0", "Done1"],
      "the sign counts every column",
    );

    // Clicking it opens the full-screen board.
    await sign.click();
    await page.waitForSelector("#office-board-backdrop");
    const panel = await page.locator("#office-board-backdrop .office-lib-panel").boundingBox();
    const view = page.viewportSize();
    assert.ok(panel.width >= view.width - 60, `the board is a full surface (${panel.width}px of ${view.width})`);
    assert.ok(panel.height >= 400, `with room for four columns (${panel.height}px)`);
    assert.match(await board().locator(".office-lib-hd-title").textContent(), /Task board/);

    // Four columns, left to right in workflow order, each headed and counted.
    assert.deepEqual(
      await board().locator(".office-kcol-head span").allTextContents(),
      ["Todo", "Planned", "In Progress", "Done"],
      "the columns run Todo → Planned → In Progress → Done",
    );
    const cols = await board().locator(".office-kcol").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
    assert.deepEqual([...cols].sort((a, b) => a - b), cols, "and are laid out in that order across the board");
    assert.equal(await kcol("todo").locator(".office-task-title").textContent(), "draft the plan");
    assert.equal(await kcol("done").locator(".office-task-title").textContent(), "ship it");
    assert.equal(await kcol("planned").locator(".office-kcol-empty").count(), 1, "an empty column says so");

    // Todo carries a New-task button — the task is written in a roomy popup,
    // not a cramped inline form.
    assert.equal(await kcol("todo").locator(".office-task-new").count(), 1, "the New-task button is under Todo");
    assert.equal(await kcol("planned").locator(".office-task-new").count(), 0, "and nowhere else");
    assert.equal(await page.locator("#office-task-form").count(), 0, "the board has no inline form");
    await page.click("#office-task-new");
    await page.waitForSelector("#office-dlg-backdrop");
    const brief = await page.locator("#office-task-note").boundingBox();
    assert.ok(brief.height >= 240, `the brief has room to write (${brief.height}px)`);
    await page.fill("#office-task-title", "review the draft");
    await page.fill("#office-task-note", "before the demo — check the migration section");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForSelector("#office-dlg-backdrop", { state: "detached" });
    await until(() => mock.officeState().tasks.length === 3, "the task is stored");
    const added = mock.officeState().tasks.find((t) => t.title === "review the draft");
    assert.equal(added.status, "todo", "a new task starts in Todo");
    assert.match(added.note, /migration section/, "the brief is stored on the task");
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#office-board-backdrop .office-kcol.todo .office-task-title')]
        .some((el) => el.textContent === "review the draft"),
    );
    assert.equal(await sign.locator(".office-kmini-col.todo b").textContent(), "2", "the meeting-room sign follows");

    // Escape closes the board, as it does the other full-screen surfaces.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#office-board-backdrop", { state: "detached" });
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a task left In Progress by an earlier visit is picked back up", async () => {
    // Nobody is working on it any more — the page that dispatched it is gone —
    // so the queue must not stall behind it forever.
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "interrupted work", status: "in_progress", createdAt: 1, startedAt: 2 }],
      },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="orchestrator"]');

    // It goes back to the head of the queue and is dispatched again. No prompt
    // is written while it is left alone in In Progress.
    const turn = await mock.nextTurn();
    const posts = mock.requestsFor("/chat", "POST");
    assert.equal(posts.length, 1, "the interrupted task was re-dispatched");
    assert.equal(posts[0].body.prompt, "interrupted work");

    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "Carried on." });
    turn.send({ type: "done", sessionId: turn.sessionId });
    turn.end();
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "done", "the task finishes");
    assert.equal(mock.requestsFor("/chat", "POST").length, 1, "and it runs once, not twice");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a run still in flight is adopted, never re-dispatched, when the page returns", async () => {
    // The page that dispatched this run reloaded away while pi kept working (the
    // Chat button hard-reloads), so the run is alive server-side. Returning must
    // ADOPT it — a task "left In Progress" is not the same as one with no run.
    mock.setRunStatus("live-run-1", { active: true, outcome: null });
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "long running", status: "in_progress", createdAt: 1, startedAt: 2, runSessionId: "live-run-1" }],
      },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="orchestrator"]');
    await sleep(800);
    assert.equal(mock.requestsFor("/chat", "POST").length, 0, "the live run is adopted, not started again");
    assert.equal(mock.officeState().tasks.find((t) => t.id === "t1").runSessionId, "live-run-1", "it is left alone");

    // The live run now settles: the adopted task lands in Done with no dispatch.
    mock.setRunStatus("live-run-1", { active: false, outcome: "done" });
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "done", "the adopted run settles");
    assert.equal(mock.requestsFor("/chat", "POST").length, 0, "still no dispatch");
    assert.equal(mock.officeState().tasks.find((t) => t.id === "t1").runSessionId, undefined, "and the run record is cleared");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a run that finished while away settles from its recorded outcome", async () => {
    // The wait was long enough that the run completed before the page returned:
    // its outcome is on the server, so the task settles without any dispatch.
    mock.setRunStatus("done-run-1", { active: false, outcome: "done" });
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "finished away", status: "in_progress", createdAt: 1, startedAt: 2, runSessionId: "done-run-1" }],
      },
    });
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "done", "the task settles from the outcome");
    assert.equal(mock.requestsFor("/chat", "POST").length, 0, "nothing was dispatched");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("an adopted run that failed returns its task to Planned, un-run", async () => {
    mock.setRunStatus("err-run-1", { active: false, outcome: "error" });
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "broken away", status: "in_progress", createdAt: 1, startedAt: 2, runSessionId: "err-run-1" }],
      },
    });
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "planned", "the failed task returns to Planned");
    await sleep(400);
    assert.equal(mock.requestsFor("/chat", "POST").length, 0, "a failed run is not retried on its own");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("switching to Chat and back does not start a second run (the reported bug)", async () => {
    // The Chat nav hard-reloads the page (`reloadChat`), which aborts the office's
    // response stream while pi keeps working. Returning to Office must adopt that
    // still-live run — never dispatch the task a second time.
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "keep working", status: "planned", createdAt: 1, plannedAt: 2 }],
      },
    });
    const turn = await mock.nextTurn();
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "in_progress", "the task is dispatched");
    assert.equal(mock.requestsFor("/chat", "POST").length, 1);

    // Leave to Chat (full reload) and come straight back, all while the run is live.
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#btn-chat")]);
    await page.waitForSelector("#btn-office");
    await page.click("#btn-office");
    await page.waitForSelector("#office-pane .office-pod");
    await sleep(1200);
    assert.equal(mock.requestsFor("/chat", "POST").length, 1, "the live run was adopted, not restarted");
    assert.equal(mock.officeState().tasks.find((t) => t.id === "t1").status, "in_progress", "and left running");

    // The run the first page started now finishes; the returning page settles it.
    turn.send({ type: "msg_start" });
    turn.send({ type: "text", delta: "Kept working." });
    turn.send({ type: "done", sessionId: turn.sessionId });
    turn.end();
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "done", "the adopted run settles to Done");
    assert.equal(mock.requestsFor("/chat", "POST").length, 1, "one task, one run — no redispatch");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a dispatch the server refuses is parked, never retried on its own", async () => {
    // A fast rejection means no run started. The task goes back to Planned and is
    // parked, so the runner cannot spin on a doomed dispatch.
    mock.failNext("/chat", "POST", 500);
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "doomed", status: "planned", createdAt: 1, plannedAt: 2 }],
      },
    });
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "planned", "the refused task returns to Planned");
    await sleep(700);
    assert.equal(mock.requestsFor("/chat", "POST").length, 1, "the task is not re-dispatched");
    // The injected 500 is exactly the failure under test — it is logged as a page
    // error by the harness, which is expected here.
  });

  test("the board hands planned tasks to the orchestrator one at a time, in order", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: { runnerPaused: false },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="orchestrator"]');
    // The orchestrator runs on the model its desk is set to.
    await page.selectOption("#office-orch-model", "deepseek/deepseek-v4-flash");
    await until(() => mock.state.team.defaultModel === "deepseek/deepseek-v4-flash", "the orchestrator's model is written");
    await page.click("#office-board-open");
    await page.waitForSelector("#office-board-backdrop");
    // The runner is switched on at boot for this test, so the board offers Pause.
    assert.match(await page.textContent("#office-run-toggle"), /pause/i, "the runner is running");

    // 1. The user creates two tasks (in the roomy popup); both land in Todo.
    const newTask = async (title) => {
      await page.click("#office-task-new");
      await page.waitForSelector("#office-dlg-backdrop");
      await page.fill("#office-task-title", title);
      await page.click("#office-dlg-backdrop .office-dialog-ok");
      await page.waitForSelector("#office-dlg-backdrop", { state: "detached" });
      await page.waitForFunction((t) =>
        [...document.querySelectorAll('#office-board-backdrop .office-kcol.todo .office-task-title')]
          .some((el) => el.textContent === t), title);
    };
    for (const title of ["first task", "second task"]) await newTask(title);
    assert.deepEqual(await colTitles("todo"), ["first task", "second task"], "both tasks wait in Todo");
    assert.equal(mock.requestsFor("/chat", "POST").length, 0, "nothing runs while the tasks are in Todo");

    // 2. Moving the first one to Planned hands it to the orchestrator: the queue
    // runner puts it In Progress and dispatches it as its own chat turn.
    const rowFor = (title) => board().locator(".office-task", { hasText: title });
    await rowFor("first task").locator('.office-task-move[data-move="planned"]').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#office-board-backdrop .office-kcol.in_progress .office-task-title')]
        .some((el) => el.textContent === "first task"),
    );
    const turn1 = await mock.nextTurn();
    await until(() => mock.officeState().tasks.find((t) => t.title === "first task").status === "in_progress", "the first task is in progress");
    const posts = () => mock.requestsFor("/chat", "POST");
    assert.equal(posts().length, 1, "the first task was dispatched");
    assert.equal(posts()[0].body.prompt, "first task", "the task's title is the prompt");
    assert.equal(posts()[0].body.model, "deepseek/deepseek-v4-flash", "and it runs on the model the desk is set to");
    assert.equal(await kcol("in_progress").locator(".office-task-title").textContent(), "first task");
    assert.match(await board().locator(".office-board-now").textContent(), /first task/);

    // 3-4. A task planned while the orchestrator is busy queues up — it is not
    // started in parallel, however long the current run takes.
    await rowFor("second task").locator('.office-task-move[data-move="planned"]').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#office-board-backdrop .office-kcol.planned .office-task-title')]
        .some((el) => el.textContent === "second task"),
    );
    await sleep(400);
    assert.equal(posts().length, 1, "only one task runs at a time");
    assert.equal(mock.officeState().tasks.find((t) => t.title === "second task").status, "planned", "the second waits in Planned");

    // 5. The run finishes: the task moves to Done by itself.
    turn1.send({ type: "msg_start" });
    turn1.send({ type: "text", delta: "All done." });
    turn1.send({ type: "done", sessionId: turn1.sessionId });
    turn1.end();
    await until(() => mock.officeState().tasks.find((t) => t.title === "first task").status === "done", "the first task finishes");
    assert.deepEqual(await colTitles("done"), ["first task"], "the finished task lands in Done");

    // 6-7. The runner picks up the next planned task without being asked.
    const turn2 = await mock.nextTurn();
    assert.equal(posts().length, 2, "the next task was dispatched on its own");
    assert.equal(posts()[1].body.prompt, "second task");
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#office-board-backdrop .office-kcol.in_progress .office-task-title')]
        .some((el) => el.textContent === "second task"),
    );
    assert.deepEqual(await colTitles("done"), ["first task"], "the queue advanced only once the first was done");

    turn2.send({ type: "msg_start" });
    turn2.send({ type: "text", delta: "Done too." });
    turn2.send({ type: "done", sessionId: turn2.sessionId });
    turn2.end();
    await until(() => mock.officeState().tasks.find((t) => t.title === "second task").status === "done", "the second task finishes");
    await page.waitForFunction(() =>
      document.querySelectorAll('#office-board-backdrop .office-kcol.done .office-task-title').length === 2,
    );
    assert.deepEqual(await colTitles("done"), ["first task", "second task"], "both tasks are done, in order");
    assert.deepEqual(await colTitles("planned"), [], "the queue is empty");
    assert.deepEqual(await colTitles("in_progress"), [], "and nothing is left running");
    assert.equal(posts().length, 2, "two tasks, two runs — no redispatch");

    // A run that cannot settle puts its task back in the queue instead of
    // losing it, and stops pumping (no spinning on a broken turn).
    await newTask("third task");
    await rowFor("third task").locator('.office-task-move[data-move="planned"]').click();
    const turn3 = await mock.nextTurn();
    turn3.send({ type: "msg_start" });
    turn3.send({ type: "error", error: "boom" });
    turn3.send({ type: "done", error: "boom", sessionId: turn3.sessionId });
    turn3.end();
    await until(() => mock.officeState().tasks.find((t) => t.title === "third task").status === "planned", "the failed task returns to Planned");
    assert.deepEqual(await colTitles("planned"), ["third task"], "the task is not lost");
    assert.equal(await pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the board starts paused, and Run is what works the queue", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: { tasks: [{ id: "t1", title: "queued work", status: "planned", createdAt: 1, plannedAt: 2 }] },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="orchestrator"]');

    // The default is paused: a task sitting in Planned is never dispatched until
    // the user asks for it.
    await sleep(400);
    assert.equal(mock.officeState().runnerPaused, true, "the runner defaults to paused");
    assert.equal(mock.requestsFor("/chat", "POST").length, 0, "a planned task waits for Run");

    // The board's switch starts the queue.
    await page.click("#office-board-open");
    await page.waitForSelector("#office-board-backdrop");
    assert.match(await page.textContent("#office-run-toggle"), /run/i, "the switch offers Run");
    assert.match(await page.textContent("#office-board-now"), /paused/i, "and the board says so");
    await page.click("#office-run-toggle");
    const turn = await mock.nextTurn();
    assert.equal(mock.requestsFor("/chat", "POST").length, 1, "Run dispatches the queued task");
    assert.equal(mock.requestsFor("/chat", "POST")[0].body.prompt, "queued work");
    assert.equal(await page.textContent("#office-run-toggle"), "⏸ Pause", "the switch now offers Pause");

    turn.send({ type: "done", sessionId: turn.sessionId });
    turn.end();
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "done", "the task finishes");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("pausing aborts the run in flight and returns its task to Planned", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "long task", status: "planned", createdAt: 1, plannedAt: 2 }],
      },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="orchestrator"]');
    const turn = await mock.nextTurn();
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "in_progress", "the task starts");

    await page.click("#office-board-open");
    await page.waitForSelector("#office-board-backdrop");
    assert.match(await page.textContent("#office-run-toggle"), /pause/i, "the runner is running");
    await page.click("#office-run-toggle");

    // The run is aborted and its task goes back to the queue — not to Done.
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "planned", "the task returns to Planned");
    await page.waitForFunction(() => document.getElementById("office-run-toggle")?.textContent === "▶ Run");
    assert.equal(mock.officeState().runnerPaused, true, "the server was told to pause");
    assert.match(await page.textContent("#office-board-now"), /paused/i);
    assert.equal(mock.requestsFor("/chat", "POST").length, 1, "the task ran once and was not redispatched");

    // The client dropped the stream; the scripted turn can settle quietly.
    turn.send({ type: "done", sessionId: turn.sessionId });
    turn.end();
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  // ── Coverage the suite above does not touch ──────────────────────────────

  test("refreshing the roster refetches it, and a failed refresh keeps the last floor", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // A team added on the server behind the page's back shows up after refresh.
    mock.state.team.teams.ops = [{ name: "deployer" }];
    mock.state.team.teamsOrder = [...mock.state.team.teamsOrder, "ops"];
    await page.click("#office-refresh");
    await page.waitForSelector('#office-pane .office-room[data-room="team:ops"]');
    assert.equal(await pod("deployer").count(), 1);

    // A refresh that fails must not blank the floor it is already drawing: the
    // office falls back to the roster it has.
    mock.failNext("/agent-team", "GET", 500);
    await page.click("#office-refresh");
    await sleep(400);
    assert.equal(await page.locator('#office-pane .office-room[data-room="team:ops"]').count(), 1, "the last good roster stays on the floor");
    assert.equal(await pod("deployer").count(), 1, "and so do its desks");
  });

  test("a board task moves backwards and can be deleted", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      office: {
        tasks: [
          { id: "t1", title: "keep me", status: "done", createdAt: 1, finishedAt: 2 },
          { id: "t2", title: "drop me", status: "todo", createdAt: 3 },
        ],
      },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    await page.click("#office-board-open");
    await page.waitForSelector("#office-board-backdrop");

    // Done -> In Progress via the row's own back control.
    await board().locator('.office-task[data-id="t1"] .office-task-move[data-move="in_progress"]').click();
    await page.waitForFunction(() =>
      document.querySelector('#office-board-backdrop .office-kcol.in_progress .office-task-title')?.textContent === "keep me");
    const moved = mock.officeState().tasks.find((t) => t.id === "t1");
    assert.equal(moved.status, "in_progress");
    assert.ok(moved.startedAt > 0, "entering In Progress stamps startedAt");

    // Delete removes just that task from the board and the server.
    await board().locator('.office-task[data-id="t2"] .office-task-del').click();
    await page.waitForFunction(() => !document.querySelector('#office-board-backdrop .office-task[data-id="t2"]'));
    assert.equal(mock.officeState().tasks.some((t) => t.id === "t2"), false);
    assert.deepEqual(await colTitles("in_progress"), ["keep me"], "the other task is untouched");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a task's brief rides with the dispatch prompt", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "orchestrator" })],
      office: {
        runnerPaused: false,
        tasks: [{ id: "t1", title: "draft the plan", note: "cover the migration", status: "planned", createdAt: 1, plannedAt: 2 }],
      },
    });
    const turn = await mock.nextTurn();
    await until(() => mock.requestsFor("/chat", "POST").length === 1, "the task dispatches");
    assert.equal(mock.requestsFor("/chat", "POST")[0].body.prompt, "draft the plan\n\ncover the migration", "title and brief together");
    turn.send({ type: "done", sessionId: turn.sessionId });
    turn.end();
    await until(() => mock.officeState().tasks.find((t) => t.id === "t1").status === "done", "the task finishes");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a hire with an invalid or duplicate name is refused without a write", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    await pod("orchestrator").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.click("#office-settings-backdrop .office-set-hire");
    await page.waitForSelector("#office-dlg-backdrop");

    // `builder` is already on dev: the form refuses it and stays open.
    await page.fill("#office-hire-name", "builder");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await sleep(200);
    assert.equal(await page.locator("#office-dlg-backdrop").count(), 1, "the dialog stays open on a duplicate");

    // A name the server would reject never reaches it either.
    await page.fill("#office-hire-name", "bad name!");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await sleep(200);
    assert.equal(
      mock.requestsFor("/agent-team", "POST").filter((r) => r.body.action === "addMember").length,
      0,
      "no addMember write for a duplicate or invalid name",
    );
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("an invalid or duplicate team name is refused without a write", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    await page.click("#office-teams-open");
    await page.waitForSelector("#office-teams-backdrop");

    for (const name of ["dev", "bad name!"]) {
      await page.fill("#office-team-new", name);
      await page.click("#office-teams-backdrop .office-lib-add-btn");
      await sleep(200);
    }
    assert.equal(
      mock.requestsFor("/agent-team", "POST").filter((r) => r.body.action === "addTeam").length,
      0,
      "no addTeam write for a duplicate or invalid name",
    );
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the settings popup's model picker writes the model it shows", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');

    // The orchestrator's popup writes the app's default model, and the floor's
    // own picker follows it.
    await pod("orchestrator").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.selectOption("#office-settings-backdrop .office-model-select", "anthropic/claude-sonnet-4");
    await until(() => mock.state.team.defaultModel === "anthropic/claude-sonnet-4", "the default model is written");
    await page.waitForFunction(() => document.getElementById("office-orch-model")?.value === "anthropic/claude-sonnet-4");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#office-settings-backdrop", { state: "detached" });

    // A member's popup writes that member's own teams.yaml row.
    await pod("builder").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.selectOption("#office-settings-backdrop .office-model-select", "deepseek/deepseek-v4-flash");
    await until(() =>
      (mock.state.team.teams.dev.find((m) => m.name === "builder") || {}).model === "deepseek/deepseek-v4-flash",
      "the member's model is written");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a member on two teams keeps each desk's own model", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        activeTeam: "dev",
        teamsOrder: ["dev", "review"],
        teams: {
          dev: [{ name: "orchestrator" }, { name: "builder", model: "google/gemini-2.5-flash-lite" }],
          review: [{ name: "builder", model: "deepseek/deepseek-v4-flash" }],
        },
      }),
    });
    const deskIn = (t) => page.locator(`#office-pane .office-room[data-room="team:${t}"] .office-pod[data-key="builder"]`);
    await deskIn("review").waitFor();
    assert.equal(await deskIn("dev").locator(".office-model-select").inputValue(), "google/gemini-2.5-flash-lite");
    assert.equal(await deskIn("review").locator(".office-model-select").inputValue(), "deepseek/deepseek-v4-flash");

    // Changing one desk writes only its own team row; the other seat is left
    // exactly as it was, on the floor and in the file.
    await deskIn("dev").locator(".office-model-select").selectOption("anthropic/claude-sonnet-4");
    await until(() =>
      (mock.state.team.teams.dev.find((m) => m.name === "builder") || {}).model === "anthropic/claude-sonnet-4",
      "the dev row is written");
    assert.equal(await deskIn("review").locator(".office-model-select").inputValue(), "deepseek/deepseek-v4-flash", "the review desk is untouched");
    assert.equal((mock.state.team.teams.review.find((m) => m.name === "builder") || {}).model, "deepseek/deepseek-v4-flash");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("roster text is escaped, never markup", async () => {
    const nasty = '<img src=x onerror="window.__pwned=1">';
    const disp = 'Bob "B" <b>x</b>';
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({
        teamsOrder: ["dev"],
        teams: { dev: [{ name: "builder", displayName: disp }] },
        library: [{ id: "lib_1", path: `${WS}/docs/arch.md`, note: nasty }],
      }),
      office: { tasks: [{ id: "t1", title: nasty, status: "todo", createdAt: 1 }] },
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    assert.equal(await page.evaluate(() => window.__pwned), undefined, "no injected script ran");
    assert.equal(await page.locator("#office-pane .office-pod").count(), 2, "no injected pods");
    assert.equal(await pod("builder").locator(".office-name").textContent(), disp, "the display name is shown as text");
    assert.equal(await pod("builder").locator(".office-name b").count(), 0, "and not parsed as markup");

    await page.click("#office-board-open");
    await page.waitForSelector("#office-board-backdrop");
    assert.equal(await page.locator("#office-board-backdrop .office-task-title").first().textContent(), nasty);
    assert.equal(await page.locator("#office-board-backdrop .office-task-title img").count(), 0);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("removing every team leaves a floor with just the orchestrator", async () => {
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      team: defaultTeam({ activeTeam: "dev", teamsOrder: ["dev"], teams: { dev: [{ name: "builder" }] } }),
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    await page.click("#office-teams-open");
    await page.waitForSelector("#office-teams-backdrop");
    await page.click('#office-teams-backdrop .office-team-row[data-team="dev"] .office-team-del');
    await until(() => Object.keys(mock.state.team.teams || {}).length === 0, "every team is gone");
    await page.waitForFunction(() => document.querySelectorAll('#office-pane .office-room[data-room^="team:"]').length === 0);

    // The orchestrator keeps its office, the meeting room stays, and the member
    // that ran without a team now holds an ad-hoc desk.
    assert.equal(await pod("orchestrator").count(), 1);
    assert.equal(await page.locator('#office-pane .office-room[data-room="meeting"]').count(), 1);
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("hiring back an agent whose definition still exists leaves it untouched", async () => {
    const content = "---\nname: file_reader\n---\n\nRead files.\n";
    await boot({
      sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })],
      defs: [{ file: "file_reader.md", name: "file_reader", content }],
    });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    await pod("orchestrator").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.selectOption("#office-settings-backdrop .office-set-hire-team", "dev");
    await page.click("#office-settings-backdrop .office-set-hire");
    await page.waitForSelector("#office-dlg-backdrop");
    assert.equal(await page.locator("#office-hire-md").isChecked(), true, "the create checkbox starts on");
    await page.fill("#office-hire-name", "file_reader");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForSelector("#office-dlg-backdrop", { state: "detached" });

    // The member lands on the team; the definition that already exists is never
    // clobbered and never re-created (which the server would refuse).
    await until(() => (mock.state.team.teams.dev || []).some((m) => m.name === "file_reader"), "the member is hired");
    assert.equal(
      mock.requestsFor("/settings", "POST").filter((r) => r.body.action === "createAgentDefFile").length,
      0,
      "no doomed create was fired",
    );
    assert.equal(mock.state.agentDefs.find((d) => d.file === "file_reader.md").content, content, "the definition is untouched");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a display name the server refuses is reported, not dropped", async () => {
    await boot({ sessions: [makeSession({ session_id: SID, cwd: WS, agent_name: "builder" })] });
    await page.waitForSelector('#office-pane .office-pod[data-key="builder"]');
    await pod("orchestrator").locator('.office-act[data-act="settings"]').click();
    await page.waitForSelector("#office-settings-backdrop");
    await page.selectOption("#office-settings-backdrop .office-set-hire-team", "review");
    await page.click("#office-settings-backdrop .office-set-hire");
    await page.waitForSelector("#office-dlg-backdrop");
    await page.fill("#office-hire-name", "writer");
    // A colon cannot live in a teams.yaml value line, so the server refuses it.
    await page.fill("#office-hire-display", "Bob: the writer");
    await page.click("#office-dlg-backdrop .office-dialog-ok");
    await page.waitForSelector("#office-dlg-backdrop", { state: "detached" });

    await until(() => (mock.state.team.teams.review || []).some((m) => m.name === "writer"), "the member is hired");
    assert.equal(
      (mock.state.team.teams.review.find((m) => m.name === "writer") || {}).displayName,
      undefined,
      "the refused name was not stored",
    );
    // The hire still reports the part that failed instead of pretending success.
    await page.waitForFunction(() => /hired — but/.test(document.getElementById("scope-toast")?.textContent || ""));
    assert.ok(await page.locator("#scope-toast").evaluate((el) => el.classList.contains("warn")), "the toast warns");
  });
});
