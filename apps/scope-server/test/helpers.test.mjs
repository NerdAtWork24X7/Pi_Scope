// Unit tests for the shared frontend helpers (public/helpers.js) the Chat view
// leans on to draw the media pi returns — a screenshot, a chart, an inline data:
// URI, a video link — plus the URL autolinking and the size/sort pass.
//
// helpers.js is a browser IIFE that hangs its exports on window.SCOPE, so it is
// evaluated in a bare VM context with a stub window/document rather than
// imported. Only the pure functions are exercised; nothing here touches the DOM.
//
//   node --test apps/scope-server/test/helpers.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "public", "helpers.js"), "utf8");

function loadScope() {
  // helpers.js installs delegated model-picker listeners at load time, so the
  // stub is a minimal event target: the pure helpers below never fire them.
  const listen = () => {};
  const sandbox = {
    console,
    document: { body: { hasAttribute: () => false }, addEventListener: listen, removeEventListener: listen },
    addEventListener: listen,
    removeEventListener: listen,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: "helpers.js" }).runInContext(sandbox);
  return sandbox.window.SCOPE;
}

const S = loadScope();
// Values crossing the VM realm boundary carry that realm's Array/Object
// prototypes, which deepStrictEqual rejects — round-trip through JSON so the
// comparison is on plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

describe("composer attachments", () => {
  test("an attachment block lists the paths, and is empty with nothing attached", () => {
    assert.equal(S.attachmentsBlock([]), "");
    assert.equal(S.attachmentsBlock(null), "");
    assert.equal(S.attachmentsBlock(["", "   "]), "", "blank paths are dropped");
    const block = S.attachmentsBlock([".pi-scope/attachments/chart.png", "/abs/report.pdf"]);
    assert.match(block, /^Attached files \(read each from its path\):/);
    assert.match(block, /- \.pi-scope\/attachments\/chart\.png/);
    assert.match(block, /- \/abs\/report\.pdf/);
  });
});

describe("media in result text", () => {
  test("finds markdown images, bare image URLs and inline data URIs", () => {
    const text =
      "Here you go:\n" +
      "![a dot](data:image/png;base64,iVBORw0KGgo=)\n" +
      "https://example.com/chart.png?size=2\n" +
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==\n";
    const items = S.mediaInText(text);
    assert.deepEqual(plain(items.map((i) => i.src)), [
      "data:image/png;base64,iVBORw0KGgo=",
      "https://example.com/chart.png?size=2",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    ]);
    assert.equal(items[0].alt, "a dot", "markdown alt text is carried through");
    assert.deepEqual(plain(items.map((i) => i.kind)), ["image", "image", "image"]);
  });

  test("flags a video file and a YouTube link, deriving a poster for the latter", () => {
    const items = S.mediaInText(
      "clip https://cdn.example.com/demo.mp4 and https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    assert.deepEqual(plain(items.map((i) => i.kind)), ["video", "video"]);
    assert.equal(items[0].poster, "", "a direct file has no derived poster");
    assert.equal(items[1].poster, "https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
    assert.equal(S.mediaKind("https://youtu.be/abcdefghijk"), "video", "a youtu.be short link counts");
    assert.equal(S.mediaKind("https://x.dev/a.png"), "image");
  });

  test("ignores plain links, non-image data URIs and disallowed schemes", () => {
    const text = [
      "see https://example.com/report.pdf",
      "[a doc](https://example.com/doc)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "javascript:alert(1)",
      "logo.svg on its own is not a URL",
    ].join(" ");
    assert.deepEqual(plain(S.mediaInText(text)), []);
  });

  test("de-duplicates repeated sources and caps the count", () => {
    const one = "https://x.dev/a.png";
    assert.equal(S.mediaInText(`${one} ${one} ${one}`).length, 1);
    const many = Array.from({ length: 40 }, (_, i) => `https://x.dev/${i}.png`).join(" ");
    assert.equal(S.mediaInText(many).length, 12, "a pathological payload is capped");
  });

  test("renders a safe, lazy media table with a placeholder size", () => {
    const html = S.resultMediaHtml("![alt text](https://x.dev/a.png)");
    assert.match(html, /<div class="result-images img-gallery">/);
    assert.match(html, /<table class="image-table">/);
    assert.match(html, /<img src="https:\/\/x\.dev\/a\.png" alt="alt text"/);
    assert.match(html, /loading="lazy"/);
    assert.match(html, /data-img-size>measuring…</);
    assert.equal(S.resultMediaHtml("nothing here"), "", "no media, no table");
  });

  test("the media table folds behind a summary and starts collapsed", () => {
    const html = S.resultMediaHtml(
      "![one](https://x.dev/a.png) ![two](https://x.dev/b.png)"
    );
    assert.match(html, /^<details class="result-media">/, "the block starts collapsed");
    assert.doesNotMatch(html, /<details class="result-media" open>/, "it is not expanded by default");
    assert.match(html, /<summary class="result-media-sum">/);
    assert.match(html, /class="result-media-label"/, "a labelled header like a Thought block");
    assert.match(html, /class="result-media-count">2</, "the summary counts the items");
    // The table itself is inside the fold, so collapsing hides it.
    assert.match(html, /<summary[\s\S]*<table class="image-table">[\s\S]*<\/details>$/, "the table sits inside the fold");
  });

  test("a video row draws a still with a play badge, its name linking to the video", () => {
    const html = S.resultMediaHtml("watch https://youtu.be/dQw4w9WgXcQ");
    assert.match(html, /data-kind="video"/);
    assert.match(html, /<img src="https:\/\/img\.youtube\.com\/vi\/dQw4w9WgXcQ\/mqdefault\.jpg"/);
    assert.match(html, /class="media-play"/);
    assert.match(html, /href="https:\/\/youtu\.be\/dQw4w9WgXcQ"[^>]*title="youtube\.com — dQw4w9WgXcQ"/);
    // A direct file has no derivable poster, so the row shows a <video> that
    // frames itself.
    const direct = S.resultMediaHtml("clip https://cdn.example.com/demo.mp4");
    assert.match(direct, /<video src="https:\/\/cdn\.example\.com\/demo\.mp4"/, "a direct file plays in place");
  });

  test("names media by its YouTube id, URL's last segment, or data: type", () => {
    assert.equal(S.mediaFileName("https://x.dev/a/b/chart.png?w=2"), "chart.png");
    assert.equal(S.mediaFileName("data:image/png;base64,iVBORw0KGgo="), "inline png");
    assert.equal(S.mediaFileName("https://youtu.be/dQw4w9WgXcQ"), "youtube.com — dQw4w9WgXcQ");
    assert.equal(S.mediaFileName(""), "media");
  });

  test("finds a local media path only when a resolver can serve it", () => {
    const resolve = (p) => `/media?path=${encodeURIComponent(p)}`;
    const items = S.mediaInText("saved to tmp/sachin_tendulkar.jpg and ./shot.png and clip.mp4", { resolve });
    assert.deepEqual(plain(items.map((i) => i.name)), [
      "tmp/sachin_tendulkar.jpg", "./shot.png", "clip.mp4",
    ]);
    assert.deepEqual(plain(items.map((i) => i.kind)), ["image", "image", "video"]);
    assert.equal(items[0].local, true);
    assert.equal(items[0].src, "/media?path=tmp%2Fsachin_tendulkar.jpg");
    // Without a resolver a filesystem path is not a source we can draw…
    assert.deepEqual(plain(S.mediaInText("saved to tmp/sachin_tendulkar.jpg")), []);
    // …and a real URL is never mistaken for one.
    assert.deepEqual(
      plain(S.mediaInText("see https://x.dev/tmp/a.png", { resolve }).map((i) => i.src)),
      ["https://x.dev/tmp/a.png"]
    );
    // A path with a non-media extension is left alone.
    assert.deepEqual(plain(S.mediaInText("wrote tmp/report.pdf", { resolve })), []);
    // A markdown link's LABEL is not a path — only its parenthesised target is.
    assert.deepEqual(
      plain(S.mediaInText("[chart.png](https://x.dev/a.png)", { resolve }).map((i) => i.src)),
      ["https://x.dev/a.png"]
    );
    assert.deepEqual(
      plain(S.mediaInText("[chart](tmp/chart.png)", { resolve }).map((i) => i.name)),
      ["tmp/chart.png"]
    );
  });

  test("localOnly narrows the table to the bare paths the prose cannot draw", () => {
    const resolve = (p) => `/media?path=${encodeURIComponent(p)}`;
    const text = "![a dot](data:image/png;base64,iVBORw0KGgo=) https://x.dev/a.png saved to tmp/chart.png";
    assert.equal(S.mediaInText(text, { resolve }).length, 3, "the full extractor keeps everything");
    assert.deepEqual(
      plain(S.mediaInText(text, { resolve, localOnly: true }).map((i) => i.name)),
      ["tmp/chart.png"],
      "only the local path still needs a table row"
    );
  });

  test("a local path becomes a table row whose name is the path, thumbnail the served file", () => {
    const resolve = (p) => `/media?path=${encodeURIComponent(p)}`;
    const html = S.resultMediaHtml("saved to tmp/chart.png", { resolve });
    assert.match(html, /data-local="1"/);
    assert.match(html, /<img src="\/media\?path=tmp%2Fchart\.png"/);
    assert.match(html, /title="tmp\/chart\.png"/, "the row keeps the original path as its label");
    // A source the resolver refuses yields no table at all.
    assert.equal(S.resultMediaHtml("saved to tmp/chart.png", { resolve: () => "" }), "");
  });
});

describe("markdown image rendering", () => {
  test("markdown images and bare image URLs both become <img>", () => {
    const marked = S.markdownHtml("![a dot](data:image/png;base64,iVBORw0KGgo=)");
    assert.match(marked, /<img src="data:image\/png;base64,iVBORw0KGgo="/);
    const bare = S.markdownHtml("shot: https://x.dev/a.gif");
    assert.match(bare, /<img src="https:\/\/x\.dev\/a\.gif"/);
  });

  test("a markdown LINK to a picture draws the picture, label as alt text", () => {
    const html = S.markdownHtml(
      "Original URL: [Sachin-Tendulkar.jpg](https://upload.wikimedia.org/wikipedia/commons/6/66/Sachin-Tendulkar.jpg)"
    );
    assert.match(
      html,
      /<img src="https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/6\/66\/Sachin-Tendulkar\.jpg" alt="Sachin-Tendulkar\.jpg"/
    );
    // A link to something that is not a picture stays a plain link.
    const doc = S.markdownHtml("[report](https://x.dev/report.pdf)");
    assert.match(doc, /<a href="https:\/\/x\.dev\/report\.pdf"/);
    assert.doesNotMatch(doc, /<img/);
  });

  test("a plain link stays a link, and a javascript: source is never an image", () => {
    assert.doesNotMatch(S.markdownHtml("see https://x.dev/report.pdf"), /<img/);
    const evil = S.markdownHtml("![x](javascript:alert(1))");
    assert.doesNotMatch(evil, /<img/, "a javascript: source is refused");
    assert.doesNotMatch(evil, /<a /, "and never becomes a link either");
  });

  test("a markdown link to a local picture resolves through the resolver", () => {
    const resolve = (p) => `/media?path=${encodeURIComponent(p)}`;
    const md = S.markdownHtml("[chart](tmp/chart.png)", { dropImages: true, resolve });
    assert.match(md, /<a href="\/media\?path=tmp%2Fchart\.png"[^>]*>chart<\/a>/);
    // With no resolver the reference cannot be served, so it stays literal text.
    assert.match(S.markdownHtml("[chart](tmp/chart.png)", { dropImages: true }), /\[chart\]\(tmp\/chart\.png\)/);
  });

  test("dropImages keeps pictures out of the prose, and a bare URL becomes a link", () => {
    const md = S.markdownHtml(
      "see ![x](https://x.dev/a.png) and [pic.jpg](https://x.dev/pic.jpg) and https://x.dev/b.gif",
      { dropImages: true }
    );
    assert.doesNotMatch(md, /<img/, "no image is inlined when the table draws it");
    assert.match(md, /<a href="https:\/\/x\.dev\/pic\.jpg"[^>]*>pic\.jpg<\/a>/, "an image link stays a link");
    assert.match(md, /<a href="https:\/\/x\.dev\/b\.gif"[^>]*>https:\/\/x\.dev\/b\.gif<\/a>/, "a bare URL is clickable");
    assert.match(md, /<p>see\s+and\s+<a /, "the embed is dropped from the sentence");
  });

  test("a bare URL pi prints becomes a clickable link, trailing punctuation aside", () => {
    const md = S.markdownHtml("see https://x.dev/report.pdf and https://youtu.be/dQw4w9WgXcQ");
    assert.match(md, /<a href="https:\/\/x\.dev\/report\.pdf"[^>]*>https:\/\/x\.dev\/report\.pdf<\/a>/);
    assert.match(md, /<a href="https:\/\/youtu\.be\/dQw4w9WgXcQ"[^>]*>https:\/\/youtu\.be\/dQw4w9WgXcQ<\/a>/);
    assert.doesNotMatch(md, /<img/);
    // The full stop after a URL stays outside the link.
    const md2 = S.markdownHtml("go to https://x.dev/report.pdf.");
    assert.match(md2, /<a href="https:\/\/x\.dev\/report\.pdf"[^>]*>https:\/\/x\.dev\/report\.pdf<\/a>\./);
  });
});

// The dimension/sort pass runs against the live DOM in the browser, so it is
// exercised here with a tiny fake tree: a table, its rows, and each row's
// thumbnail + size cell.
describe("media table sizing", () => {
  function fakeImg({ w = 0, h = 0, complete = true } = {}) {
    const listeners = {};
    return {
      naturalWidth: w,
      naturalHeight: h,
      complete,
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      fire(type) { for (const fn of listeners[type] || []) fn(); },
    };
  }
  // A <video> has no `complete`: readiness is `readyState` and the size is
  // `videoWidth`/`videoHeight`.
  function fakeVideo({ w = 0, h = 0, readyState = 1 } = {}) {
    const listeners = {};
    return {
      videoWidth: w,
      videoHeight: h,
      readyState,
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      fire(type) { for (const fn of listeners[type] || []) fn(); },
    };
  }
  function fakeRow(el) {
    const cell = { textContent: "measuring…" };
    return {
      dataset: {},
      _cell: cell,
      querySelector(sel) {
        if (sel === "[data-img-size]") return cell;
        if (sel === "img, video" || sel === "img") return el;
        return null;
      },
    };
  }
  function fakeTable(rows) {
    const order = [...rows];
    const tbody = {
      querySelectorAll: () => order,
      appendChild(r) { const i = order.indexOf(r); if (i >= 0) order.splice(i, 1); order.push(r); },
    };
    return { dataset: {}, querySelector: (s) => (s === "tbody" ? tbody : null), _order: order };
  }
  const scan = (table) => ({ querySelectorAll: () => [table] });

  test("fills each row's size and orders rows largest area first", () => {
    const small = fakeRow(fakeImg({ w: 100, h: 80 })); // 8,000
    const big = fakeRow(fakeImg({ w: 800, h: 600 })); // 480,000
    const table = fakeTable([small, big]);
    S.hydrateMediaTables(scan(table));
    assert.equal(small._cell.textContent, "100 × 80");
    assert.equal(big._cell.textContent, "800 × 600");
    assert.deepEqual(plain(table._order.map((r) => r.dataset.imgArea)), ["480000", "8000"]);
  });

  test("measures a video from its intrinsic size", () => {
    const row = fakeRow(fakeVideo({ w: 640, h: 360 }));
    const table = fakeTable([row]);
    S.hydrateMediaTables(scan(table));
    assert.equal(row._cell.textContent, "640 × 360");
    assert.equal(row.dataset.imgArea, "230400");
  });

  test("a still-loading image re-orders the rows when it lands", () => {
    const pending = fakeImg({ complete: false });
    const known = fakeRow(fakeImg({ w: 100, h: 100 })); // 10,000
    const row = fakeRow(pending);
    const table = fakeTable([row, known]);
    S.hydrateMediaTables(scan(table));
    assert.equal(known._cell.textContent, "100 × 100");
    assert.equal(row._cell.textContent, "measuring…", "an in-flight image keeps its placeholder");
    pending.naturalWidth = 900;
    pending.naturalHeight = 900;
    pending.fire("load");
    assert.equal(row._cell.textContent, "900 × 900");
    assert.deepEqual(plain(table._order.map((r) => r.dataset.imgArea)), ["810000", "10000"]);
  });

  test("a media item that fails to load is marked unavailable, and only measured once", () => {
    const broken = fakeImg({ complete: false });
    const row = fakeRow(broken);
    const table = fakeTable([row]);
    S.hydrateMediaTables(scan(table));
    broken.fire("error");
    assert.equal(row._cell.textContent, "unavailable");
    // A second pass over the same table attaches no duplicate listeners.
    S.hydrateMediaTables(scan(table));
    assert.equal(row._cell.textContent, "unavailable");
  });

  test("a local row that fails to load is removed instead of shown as unavailable", () => {
    const broken = fakeImg({ complete: false });
    const row = fakeRow(broken);
    row.dataset.local = "1";
    let removed = false;
    row.remove = () => { removed = true; };
    const table = fakeTable([row]);
    S.hydrateMediaTables(scan(table));
    broken.fire("error");
    assert.equal(removed, true, "a 404'd local path leaves no row behind");
    assert.equal(row._cell.textContent, "measuring…", "no size is written for a dropped row");
  });
});
