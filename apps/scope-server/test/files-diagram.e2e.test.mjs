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
    { from: "src/b.js", to: "src/a.js" },
    { from: "src/c.js", to: "src/a.js" },
    { from: "src/e.js", to: "src/b.js" },
    { from: "src/c.js", to: "src/f.js" },
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
async function boot() {
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
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(GRAPH) }));
  await page.goto(`${mock.base}/?token=test-token#view=files`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#diagram-svg .dnode");
  await sleep(300);
  return page;
}

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
  test("selecting a node outlines it; impact is what dims the floor and marks the blast radius", async () => {
    await boot();

    // A plain selection: outlined, floor still readable (this used to dim it all).
    await page.click('#diagram-svg [data-node="src/d.js"]');
    await sleep(120);
    const selected = await floor();
    assert.equal(selected.selected, "src/d.js");
    assert.equal(selected.dimmed, 0, "a selection alone does not dim the floor");
    assert.deepEqual(selected.impacted, []);
    assert.equal(selected.legend.includes("impact"), false, "no impact chip before the box is ticked");

    // Impact on, but this node has no blast radius: nothing to highlight means
    // nothing is dimmed either (the whole floor going grey with no red on it was
    // the report: "the impacted boxes grey out along with the others").
    await page.check("#diagram-impact");
    await sleep(120);
    const leafRadius = await floor();
    assert.deepEqual(leafRadius.impacted, [], "nothing depends on d.js, so nothing is marked");
    assert.equal(leafRadius.dimmed, 0, "an empty blast radius dims nothing");
    assert.deepEqual(leafRadius.hotEdges, [], "and no edge is lit for it");
    assert.match(leafRadius.stats, /impact 0 dependents/, "…which the readout still says");

    await page.click('#diagram-svg [data-node="src/a.js"]');
    await sleep(120);
    const impact = await floor();
    assert.deepEqual(impact.impacted, ["src/b.js", "src/c.js", "src/e.js"],
      "the transitive dependents are the blast radius");
    assert.equal(impact.dimmed, 2, "only the nodes outside the radius are dimmed");
    assert.deepEqual(impact.hotEdges, ["src/b.js→src/a.js", "src/c.js→src/a.js", "src/e.js→src/b.js"],
      "every hop of the radius is hot — and c.js→f.js is not, it leaves the radius");
    assert.match(impact.stats, /impact 3 dependents/, "the readout reports what impact found");
    assert.match(impact.legend, /impact/, "the legend explains the red outline");
    assert.match(impact.side, /impact · blast radius/, "the side panel reports it for the selected node");
    assert.match(impact.side, /3 nodes depend on this/);

    // The radius has to be visible on a dimmed floor. An unchanged dependent
    // takes the red tint; a changed one keeps its own status fill and is marked
    // by the red ring alone (the tint would out-shout its git status).
    const paint = await page.evaluate(() => {
      const box = (sel) => getComputedStyle(document.querySelector(`#diagram-svg .dnode${sel} .dbox`));
      return {
        plain: box(".impact:not(.changed)"),
        changed: box(".impact.changed"),
      };
    });
    assert.equal(paint.plain.stroke, paint.changed.stroke, "both ends of the radius carry the red ring");
    assert.notEqual(paint.changed.fill, paint.plain.fill, "a changed dependent keeps its status fill");

    // And off again: the floor reads normally, with the selection kept.
    await page.uncheck("#diagram-impact");
    await sleep(120);
    const off = await floor();
    assert.deepEqual(off.impacted, []);
    assert.equal(off.dimmed, 0, "unticking impact clears the dimming");
    assert.equal(off.selected, "src/a.js", "the selection survives the toggle");
    assert.equal(off.stats.includes("impact"), false);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });

  test("ticking impact with nothing selected highlights the review queue's top entry that has a radius", async () => {
    await boot();
    await page.check("#diagram-impact");
    await sleep(120);

    const floorNow = await floor();
    assert.equal(floorNow.selected, "src/a.js",
      "src/d.js tops the review queue but nothing depends on it, so the next entry anchors the radius");
    assert.deepEqual(floorNow.impacted, ["src/b.js", "src/c.js", "src/e.js"]);
    assert.match(floorNow.stats, /impact 3 dependents/);
    assert.match(floorNow.side, /highlighted on the floor/, "the side panel lists the radius it found");

    // A node nothing depends on still says so, rather than looking like the toggle
    // never ran.
    await page.click('#diagram-svg [data-node="src/d.js"]');
    await sleep(120);
    const leaf = await floor();
    assert.deepEqual(leaf.impacted, [], "a leaf has no blast radius");
    assert.equal(leaf.dimmed, 0, "an empty blast radius dims nothing");
    assert.match(leaf.stats, /impact 0 dependents/);
    assert.match(leaf.side, /nothing on the floor depends on this/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });
});
