// End-to-end tests for the Review view's dependency diagram, run in headless
// Chromium against the mock backend in ./mock-backend.mjs (which serves the real
// public/ assets). The mock's own /files/graph is empty (its cwd is not a repo),
// so the graph under test is fulfilled through `page.route` — the same shape the
// real server returns (see buildRepoGraph in server.ts).
//
//   node --test apps/scope-server/test/files-diagram.e2e.test.mjs
//
// These cover the "impact" toggle: the blast radius of the selected node is what
// dims the floor and paints dependents red, and it reports what it found. It used
// to dim everything on a plain click, so ticking the box looked like a no-op.

import { test, before, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startMockBackend } from "./mock-backend.mjs";
import { launchBrowser, sleep } from "./harness.mjs";

const WS = "/tmp/pi-scope-e2e/alpha";

/**
 * b.js and c.js import a.js; e.js imports b.js, so e.js is in a.js's blast
 * radius transitively; c.js also imports f.js, which has nothing to do with
 * a.js. d.js imports nothing and nothing imports it — and it is CHANGED, and it
 * tops the review queue (risk ranks churn as much as fan-in), which is the case
 * that used to grey the whole floor out with nothing highlighted. e.js is
 * changed too, so the radius holds a changed node (it keeps its status fill and
 * only gains the red ring).
 */
const GRAPH = {
  cwd: WS,
  git: true,
  modules: [{ id: "src", label: "src", depth: 1, files: 6, loc: 60, changedFiles: 2, add: 43, del: 1, fanIn: 0, fanOut: 2, statuses: { added: 1, modified: 1 } }],
  edges: [],
  fileNodes: [
    { path: "src/a.js", module: "src", loc: 10, status: "modified", add: 3, del: 1, fanIn: 2, fanOut: 0 },
    { path: "src/b.js", module: "src", loc: 10, status: null, add: 0, del: 0, fanIn: 1, fanOut: 1 },
    { path: "src/c.js", module: "src", loc: 10, status: null, add: 0, del: 0, fanIn: 0, fanOut: 2 },
    { path: "src/d.js", module: "src", loc: 10, status: "added", add: 40, del: 0, fanIn: 0, fanOut: 0 },
    { path: "src/e.js", module: "src", loc: 10, status: "added", add: 0, del: 0, fanIn: 0, fanOut: 1 },
    { path: "src/f.js", module: "src", loc: 10, status: null, add: 0, del: 0, fanIn: 1, fanOut: 0 },
  ],
  fileEdges: [
    { from: "src/b.js", to: "src/a.js", specs: ["./a"] },
    { from: "src/c.js", to: "src/a.js", specs: ["./a"] },
    { from: "src/e.js", to: "src/b.js", specs: ["./b"] },
    { from: "src/c.js", to: "src/f.js", specs: ["./f"] },
  ],
  changed: [
    { path: "src/d.js", module: "src", status: "added", loc: 10, add: 40, del: 0, fanIn: 0 },
    { path: "src/a.js", module: "src", status: "modified", loc: 10, add: 3, del: 1, fanIn: 2 },
    { path: "src/e.js", module: "src", status: "added", loc: 10, add: 0, del: 0, fanIn: 0 },
  ],
  head: { hash: "abc1234", subject: "diagram fixture", author: "tester", date: "2026-01-01" },
  stats: { files: 6, modules: 1, changedFiles: 3, add: 43, del: 1, truncated: false },
};

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

/** Load the Review view with the fixture graph. */
async function boot(graph = GRAPH) {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/.test(m.text())) return;
    pageErrors.push(m.text());
  });
  await page.route("**/files/graph**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(graph) }));
  await page.goto(`${mock.base}/?token=test-token#view=files`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#diagram-svg .dnode");
  await sleep(300);
  return page;
}

/** A one-folder graph with enough files to force the folder to wrap rows. */
const WRAP_GRAPH = {
  ...GRAPH,
  fileNodes: Array.from({ length: 30 }, (_, i) => ({
    path: `src/f${String(i).padStart(2, "0")}.js`, module: "src", loc: 1,
    status: null, add: 0, del: 0, fanIn: 0, fanOut: 0,
  })),
  fileEdges: [],
  changed: [],
  modules: [{ id: "src", label: "src", depth: 1, files: 30, loc: 30, changedFiles: 0, add: 0, del: 0, fanIn: 0, fanOut: 0, statuses: {} }],
  stats: { files: 30, modules: 1, changedFiles: 0, add: 0, del: 0, truncated: false },
};

/** A two-folder graph: src holds the changed files and app depends on it, so
 *  "changed only" + impact has one changed and one impacted folder to show. */
const FOLDER_GRAPH = {
  ...GRAPH,
  modules: [
    { id: "src", label: "src", depth: 1, files: 6, loc: 60, changedFiles: 2, add: 43, del: 1, fanIn: 1, fanOut: 0, statuses: { added: 1, modified: 1 } },
    { id: "app", label: "app", depth: 0, files: 1, loc: 20, changedFiles: 0, add: 0, del: 0, fanIn: 0, fanOut: 1, statuses: {} },
  ],
  edges: [{ from: "app", to: "src", specs: ["../src/a"] }],
};

/** The floor as the DOM reads it: the classes the diagram paints. */
const floor = () => page.evaluate(() => ({
  selected: document.querySelector("#diagram-svg .dnode.sel")?.getAttribute("data-node") || null,
  impacted: [...document.querySelectorAll("#diagram-svg .dnode.impact")].map((n) => n.getAttribute("data-node")).sort(),
  dimmed: document.querySelectorAll("#diagram-svg .dnode.dim").length,
  hotEdges: [...document.querySelectorAll("#diagram-svg .dedge.hot")]
    .map((e) => `${e.getAttribute("data-from")}→${e.getAttribute("data-to")}`).sort(),
  stats: document.getElementById("diagram-stats").textContent,
  legend: document.getElementById("diagram-legend").textContent,
  side: document.getElementById("diagram-side").textContent.replace(/\s+/g, " "),
}));

describe("review diagram", () => {
  test("clicking a node immediately marks only its dependents and the wires between them", async () => {
    await boot();
    assert.equal(await page.isChecked("#diagram-impact"), true, "impact is on by default");

    // A leaf: it has no dependents, so the floor is not dimmed and the readout
    // still explains that the radius is empty.
    await page.click('#diagram-svg [data-node="src/d.js"]');
    await sleep(120);
    const leaf = await floor();
    assert.equal(leaf.selected, "src/d.js");
    assert.deepEqual(leaf.impacted, []);
    assert.equal(leaf.dimmed, 0, "an empty blast radius dims nothing");
    assert.match(leaf.stats, /impact 0 dependents/);
    assert.match(leaf.legend, /impact/);

    // Clicking a file shows its transitive dependents and only the wires inside
    // that radius; the map dims everything else.
    await page.click('#diagram-svg [data-node="src/a.js"]');
    await sleep(120);
    const impact = await floor();
    assert.deepEqual(impact.impacted, ["src/b.js", "src/c.js", "src/e.js"],
      "the transitive dependents are the blast radius");
    assert.equal(impact.dimmed, 2, "only the nodes outside the radius are dimmed");
    assert.deepEqual(impact.hotEdges, ["src/b.js→src/a.js", "src/c.js→src/a.js", "src/e.js→src/b.js"],
      "every hop of the radius is hot — and c.js→f.js is not, it leaves the radius");
    assert.match(impact.stats, /impact 3 dependents/, "the readout reports what impact found");
    assert.match(impact.side, /impact · blast radius/);
    assert.match(impact.side, /3 nodes depend on this/);
    assert.match(impact.side, /wiring · imports/);
    assert.match(impact.side, /wiring · dependents/);

    // Wires carry the literal specifier that created them; the impact path's
    // labels are emphasized along with the hot wires.
    const labels = await page.evaluate(() => ({
      all: [...document.querySelectorAll(".dedge-label")].map((el) => el.textContent).sort(),
      hot: [...document.querySelectorAll(".dedge-label.hot")].map((el) => el.textContent).sort(),
      shown: document.querySelectorAll(".dedge-label.show").length,
    }));
    assert.deepEqual(labels.all, ["./a", "./a", "./b", "./f"]);
    assert.deepEqual(labels.hot, ["./a", "./a", "./b"]);
    assert.equal(labels.shown, 4, "a small map shows every specifier");

    const paint = await page.evaluate(() => {
      const box = (sel) => getComputedStyle(document.querySelector(`#diagram-svg .dnode${sel} .dbox`));
      return {
        plain: box(".impact:not(.changed)"),
        changed: box(".impact.changed"),
      };
    });
    assert.equal(paint.plain.stroke, paint.changed.stroke, "both ends of the radius carry the red ring");
    assert.notEqual(paint.changed.fill, paint.plain.fill, "a changed dependent keeps its status fill");

    // Clicking a wire follows it to the imported file, opening that file's wiring.
    await page.evaluate(() => document.querySelector('.dedge[data-from="src/c.js"][data-to="src/f.js"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await sleep(120);
    const wired = await floor();
    assert.equal(wired.selected, "src/f.js", "a wire click navigates to the imported file");
    assert.match(wired.side, /wiring · dependents/);

    // Turning impact off leaves the wire selection and the readable floor.
    await page.uncheck("#diagram-impact");
    await sleep(120);
    const off = await floor();
    assert.deepEqual(off.impacted, []);
    assert.equal(off.dimmed, 0);
    assert.equal(off.selected, "src/f.js", "the selection survives the toggle");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("re-enabling impact with nothing selected anchors on the top changed file that has a radius", async () => {
    await boot();
    // Clear the selection (the background is the pan surface).
    await page.click("#diagram-canvas", { position: { x: 6, y: 6 } });
    await sleep(120);
    assert.equal((await floor()).selected, null);
    await page.uncheck("#diagram-impact");
    await page.check("#diagram-impact");
    await sleep(120);

    const floorNow = await floor();
    assert.equal(floorNow.selected, "src/a.js",
      "src/d.js tops the review queue but nothing depends on it, so the next entry anchors the radius");
    assert.deepEqual(floorNow.impacted, ["src/b.js", "src/c.js", "src/e.js"]);
    assert.match(floorNow.stats, /impact 3 dependents/);
    assert.match(floorNow.side, /highlighted on the floor/);

    await page.click('#diagram-svg [data-node="src/d.js"]');
    await sleep(120);
    const leaf = await floor();
    assert.deepEqual(leaf.impacted, [], "a leaf has no blast radius");
    assert.equal(leaf.dimmed, 0, "an empty blast radius dims nothing");
    assert.match(leaf.stats, /impact 0 dependents/);
    assert.match(leaf.side, /nothing on the floor depends on this/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("changed only + impact keeps the changed files beside the impacted references, colour-coded", async () => {
    await boot();
    assert.equal(await page.isChecked("#diagram-impact"), true);
    // Nothing is selected yet: ticking the second overlay anchors on the
    // default node so there is an actual radius to show. The changed files must
    // NOT replace the impacted references.
    await page.check("#diagram-changed-only");
    await sleep(250);

    const both = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("#diagram-svg .dnode")].map((n) => ({
        id: n.getAttribute("data-node"),
        changed: n.classList.contains("changed"),
        impact: n.classList.contains("impact"),
        sel: n.classList.contains("sel"),
      }));
      const paint = (sel) => {
        const el = document.querySelector(`#diagram-svg .dnode${sel} .dbox`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { fill: cs.fill, stroke: cs.stroke };
      };
      return {
        nodes,
        changedPaint: paint(".changed:not(.impact)"),
        impactPaint: paint(".impact:not(.changed)"),
        bothPaint: paint(".changed.impact"),
        dimmed: document.querySelectorAll("#diagram-svg .dnode.dim").length,
        selected: document.querySelector("#diagram-svg .dnode.sel")?.getAttribute("data-node") || null,
        stats: document.getElementById("diagram-stats").textContent,
        legend: document.getElementById("diagram-legend").textContent,
        changedLabel: document.getElementById("diagram-changed-label").textContent,
        side: document.getElementById("diagram-side").textContent.replace(/\s+/g, " "),
      };
    });

    assert.equal(both.selected, "src/a.js", "the impact anchor is picked so a radius exists");
    assert.deepEqual(both.nodes.map((n) => n.id).sort(),
      ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"],
      "the changed files and their impacted references are both kept; unrelated unchanged src/f.js is not");
    const byId = Object.fromEntries(both.nodes.map((n) => [n.id, n]));
    assert.equal(byId["src/d.js"].changed, true);
    assert.equal(byId["src/d.js"].impact, false, "a changed file outside the radius keeps its change colour only");
    assert.equal(byId["src/b.js"].changed, false);
    assert.equal(byId["src/b.js"].impact, true, "an unchanged reference shows the impact colour only");
    assert.equal(byId["src/e.js"].changed && byId["src/e.js"].impact, true,
      "a changed dependent carries both overlays");
    assert.equal(both.dimmed, 0, "changed files are never dimmed away while both overlays are on");
    assert.notEqual(both.changedPaint.fill, both.impactPaint.fill, "changed and impacted get different fills");
    assert.notEqual(both.changedPaint.stroke, both.impactPaint.stroke, "changed and impacted get different rings");
    assert.equal(both.bothPaint.stroke, both.impactPaint.stroke, "a changed dependent gains the impact ring");
    assert.match(both.legend, /impacted/);
    assert.match(both.legend, /changed \+ impacted/);
    assert.equal(both.changedLabel, "changed + impacted", "the checkbox says both overlays are showing");
    assert.match(both.stats, /impact 3 dependents/);
    assert.match(both.side, /impact · blast radius/);

    // Impact off: the changed-only view is back to just the changed files.
    // Impact on again: the impacted references return with it.
    await page.uncheck("#diagram-impact");
    await sleep(150);
    const changesOnly = await page.evaluate(() => ({
      nodes: [...document.querySelectorAll("#diagram-svg .dnode")].map((n) => n.getAttribute("data-node")).sort(),
      label: document.getElementById("diagram-changed-label").textContent,
    }));
    assert.deepEqual(changesOnly.nodes, ["src/a.js", "src/d.js", "src/e.js"]);
    assert.equal(changesOnly.label, "changed only", "impact off restores the changed-only label");
    await page.check("#diagram-impact");
    await sleep(150);
    const back = await page.evaluate(() =>
      [...document.querySelectorAll("#diagram-svg .dnode")].map((n) => n.getAttribute("data-node")).sort());
    assert.deepEqual(back, ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"]);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("both overlays also compose at folder granularity", async () => {
    await boot(FOLDER_GRAPH);
    await page.click("#diagram-gran-modules");
    await sleep(150);
    await page.check("#diagram-changed-only");
    await sleep(250);

    const folders = await page.evaluate(() => [...document.querySelectorAll("#diagram-svg .dnode")].map((n) => ({
      id: n.getAttribute("data-node"),
      changed: n.classList.contains("changed"),
      impact: n.classList.contains("impact"),
    })));
    const byId = Object.fromEntries(folders.map((f) => [f.id, f]));
    assert.deepEqual(folders.map((f) => f.id).sort(), ["app", "src"]);
    assert.equal(byId["src"].changed, true, "the changed folder is shown");
    assert.equal(byId["app"].changed, false);
    assert.equal(byId["app"].impact, true, "the folder that references it is shown as impacted");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("the changed/impact toggles are remembered per workspace", async () => {
    await boot();
    const cwdA = await page.evaluate(() => window.SCOPE.currentCwd());
    assert.ok(cwdA, "the view has a workspace to key the toggles on");

    await page.check("#diagram-changed-only");
    await sleep(150);
    let stored = await page.evaluate(() => JSON.parse(localStorage.getItem("scope-diagram-toggles") || "{}"));
    assert.deepEqual(stored[cwdA], { changedOnly: true, impact: true });

    // Both overlays restored together: the changed files and the anchored
    // impact radius come back without needing a click.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#diagram-svg .dnode");
    await sleep(200);
    assert.equal(await page.isChecked("#diagram-changed-only"), true);
    assert.equal(await page.isChecked("#diagram-impact"), true);
    let nodes = await page.evaluate(() =>
      [...document.querySelectorAll("#diagram-svg .dnode")].map((n) => n.getAttribute("data-node")).sort());
    assert.deepEqual(nodes, ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"],
      "the restored combined view re-anchors the impact radius");
    assert.equal(await page.textContent("#diagram-changed-label"), "changed + impacted");

    // Restoring impact off keeps the changed-only view.
    await page.uncheck("#diagram-impact");
    await sleep(150);
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem("scope-diagram-toggles") || "{}"));
    assert.deepEqual(stored[cwdA], { changedOnly: true, impact: false });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#diagram-svg .dnode");
    await sleep(200);
    assert.equal(await page.isChecked("#diagram-changed-only"), true);
    assert.equal(await page.isChecked("#diagram-impact"), false);
    nodes = await page.evaluate(() =>
      [...document.querySelectorAll("#diagram-svg .dnode")].map((n) => n.getAttribute("data-node")).sort());
    assert.deepEqual(nodes, ["src/a.js", "src/d.js", "src/e.js"],
      "the restored changed-only view still hides unchanged nodes while impact is off");

    // A different workspace starts from the defaults (impact on, changed only off).
    await page.evaluate(() => localStorage.setItem("scope-cwd", "/tmp/pi-scope-e2e/beta"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#diagram-svg .dnode");
    await sleep(200);
    assert.equal(await page.isChecked("#diagram-changed-only"), false);
    assert.equal(await page.isChecked("#diagram-impact"), true);

    // Coming back restores that workspace's own state.
    await page.evaluate((cwd) => localStorage.setItem("scope-cwd", cwd), cwdA);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#diagram-svg .dnode");
    await sleep(200);
    assert.equal(await page.isChecked("#diagram-changed-only"), true);
    assert.equal(await page.isChecked("#diagram-impact"), false);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("a folder with many files wraps them inside its slot instead of one tall column", async () => {
    await boot(WRAP_GRAPH);
    const layout = await page.evaluate(() => {
      const box = document.querySelector(".dfolder-box");
      const nodes = [...document.querySelectorAll("#diagram-svg .dnode")];
      const inside = nodes.filter((n) => {
        const r = n.querySelector(".dbox").getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      }).length;
      return { height: Number(box.getAttribute("height")), nodes: nodes.length, inside };
    });
    assert.equal(layout.nodes, 30);
    assert.equal(layout.inside, 30, "every file sits inside its folder slot");
    assert.ok(layout.height < 30 * 22 * 0.6,
      `30 files should wrap into a compact block, got ${layout.height}px tall`);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });
});
