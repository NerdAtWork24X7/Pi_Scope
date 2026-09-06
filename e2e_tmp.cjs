const { chromium } = require("playwright");

(async () => {
  const fs = require("fs");
  const token = fs.readFileSync("/home/alexa/wk/Pi_Scope/tmp/scope_token", "utf8").trim();
  const browser = await chromium.launch({
    executablePath: "/snap/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.type() + ": " + m.text()); });
  page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
  await page.goto(`http://127.0.0.1:43190/?token=${token}`, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => console.log("goto err", e.message));

  // Chat is the default view; wait for the chat pane to be visible
  await page.waitForSelector("#chat-pane", { state: "visible", timeout: 15000 }).catch(() => console.log("no chat pane"));

  // list workspaces
  const wsItems = await page.$$("#chat-workspaces .ws-item, #chat-workspaces .session-item, #chat-workspaces [data-cwd], #chat-workspaces .ws-row");
  console.log("workspace items found:", wsItems.length);
  const wsInfo = await page.evaluate(() => {
    const rail = document.getElementById("chat-workspaces");
    return rail ? rail.innerText.slice(0, 600) : "(no rail)";
  });
  console.log("workspace rail text:\n", wsInfo);

  // click any workspace row
  const clicked = await page.evaluate(() => {
    const rail = document.getElementById("chat-workspaces");
    if (!rail) return "no rail";
    const el = rail.querySelector(".session-item, .ws-item, [data-cwd], .ws-row");
    if (!el) return "no row";
    el.click();
    return "clicked";
  });
  console.log("click:", clicked);
  await page.waitForTimeout(2500);

  const modelSel = await page.evaluate(() => {
    const sel = document.getElementById("chat-model");
    if (!sel) return "(no model select)";
    return { value: sel.value, options: Array.from(sel.options).map(o => o.value) };
  });
  console.log("model select:", JSON.stringify(modelSel));

  // If opencode-go/glm-5.3-flash present, select it; else keep current and report
  if (modelSel && modelSel.options.length) {
    const target = "opencode-go/glm-5.3-flash";
    if (modelSel.options.includes(target)) {
      await page.selectOption("#chat-model", target);
      console.log("selected", target);
      await page.waitForTimeout(3000);
    } else {
      console.log("target option NOT present");
    }
  }

  const hint1 = await page.evaluate(() => { const h = document.getElementById("chat-composer-hint"); return h ? h.textContent : "(none)"; });
  console.log("hint after select:", hint1);

  // Type a prompt and send
  await page.fill("#chat-input", "Reply with just: UI-OK");
  await page.click("#chat-send");
  console.log("sent");

  // Wait up to 60s for a reply bubble to appear or an error note
  let result = "timeout";
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => {
      const h = document.getElementById("chat-composer-hint");
      const msgs = document.getElementById("chat-messages");
      return {
        hint: h ? h.textContent : "",
        err: msgs ? (msgs.querySelector(".chat-error-note")?.textContent || "") : "",
        text: msgs ? msgs.innerText.slice(-800) : "",
      };
    });
    if (state.hint.includes("complete") || state.err) { result = JSON.stringify(state); break; }
    if (i % 10 === 9) console.log("...waiting", i + 1, "state:", state.hint.slice(0, 80), "| err:", state.err.slice(0, 120));
  }
  console.log("final:", result.slice(0, 1200));
  console.log("console logs:", logs.slice(0, 10).join("\n"));
  await browser.close();
})().catch((e) => { console.error("E2E ERROR:", e); process.exit(1); });
