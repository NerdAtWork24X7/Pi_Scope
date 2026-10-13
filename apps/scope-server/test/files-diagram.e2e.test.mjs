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

/** a.js is imported by b.js and c.js; d.js imports nothing and nothing imports it. */
const GRAPH = {
  cwd: WS,
  git: true,
  modules: [{ id: "src", label: "src", depth: 1, files: 4, loc: 40, changedFiles: 1, add: 3, del: 1, fanIn: 0, fanOut: 2, statuses: { modified: 1 } }],
  edges: [],
  fileNodes: [
    { path: "src/a.js", module: "src", loc: 10, status: "modified", add: 3, del: 1, fanIn: 2, fanOut: 0 },
    { path: "src/b.js", module: "src", loc: 10, status: null, add: 0, del: 0, fanIn: 0, fanOut: 1 },
    { path: "src/c.js", module: "src", loc: 10, status: null, add: 0, del: 0, fanIn: 0, fanOut: 1 },
    { path: "src/d.js", module: "src", loc: 10, status: null, add: 0, del: 0, fanIn: 0, fanOut: 0 },
  ],
  fileEdges: [
    { from: "src/b.js", to: "src/a.js" },
    { from: "src/c.js", to: "src/a.js" },
  ],
  changed: [{ path: "src/a.js", module: "src", status: "modified", loc: 10, add: 3, del: 1, fanIn: 2 }],
  head: { hash: "abc1234", subject: "diagram fixture", author: "tester", date: "2026-01-01" },
  stats: { files: 4, modules: 1, changedFiles: 1, add: 3, del: 1, truncated: false },
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
  hotEdges: document.querySelectorAll("#diagram-svg .dedge.hot").length,
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

    // Impact on: everything unrelated dims, the dependents light up red.
    await page.check("#diagram-impact");
    await sleep(120);
    const impactOff = await floor();
    assert.deepEqual(impactOff.impacted, [], "nothing depends on d.js, so nothing is marked");

    await page.click('#diagram-svg [data-node="src/a.js"]');
    await sleep(120);
    const impact = await floor();
    assert.deepEqual(impact.impacted, ["src/b.js", "src/c.js"], "the transitive dependents are the blast radius");
    assert.equal(impact.dimmed, 1, "only the unrelated node is dimmed");
    assert.ok(impact.hotEdges >= 2, `the edges into the dependents are hot (${impact.hotEdges})`);
    assert.match(impact.stats, /impact 2 dependents/, "the readout reports what impact found");
    assert.match(impact.legend, /impact/, "the legend explains the red outline");
    assert.match(impact.side, /impact · blast radius/, "the side panel reports it for the selected node");
    assert.match(impact.side, /2 nodes depend on this/);

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

  test("ticking impact with nothing selected highlights the review queue's own top entry", async () => {
    await boot();
    await page.check("#diagram-impact");
    await sleep(120);

    const floorNow = await floor();
    assert.equal(floorNow.selected, "src/a.js", "the riskiest changed file is picked for the blast radius");
    assert.deepEqual(floorNow.impacted, ["src/b.js", "src/c.js"]);
    assert.match(floorNow.stats, /impact 2 dependents/);

    // A node nothing depends on still says so, rather than looking like the toggle
    // never ran.
    await page.click('#diagram-svg [data-node="src/d.js"]');
    await sleep(120);
    const leaf = await floor();
    assert.deepEqual(leaf.impacted, [], "a leaf has no blast radius");
    assert.match(leaf.stats, /impact 0 dependents/);
    assert.match(leaf.side, /nothing on the floor depends on this/);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  });
});
