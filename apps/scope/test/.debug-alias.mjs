import { startMockBackend, defaultTeam, makeSession } from "./mock-backend.mjs";
import { launchBrowser, openChat, applySessions, send, reply, wsRow, sessRow, sleep } from "./harness.mjs";

const WS_A = "/tmp/pi-scope-e2e/alpha";
const S1_EVENTS = [
  { type: "user_message", ts: 1, payload: { text: "hello" } },
  { type: "assistant_message", ts: 2, payload: { text: "RECORDED-HELLO" } },
];
const S2_EVENTS = [
  { type: "user_message", ts: 1, payload: { text: "two" } },
  { type: "assistant_message", ts: 2, payload: { text: "RECORDED-TWO" } },
];

const dump = async (page, label) => {
  const d = await page.evaluate(() => window.__chatDebug());
  console.log(`\n=== ${label} ===`);
  console.log("curId=", d.curId, "openSid=", d.openSid, "chatSessionId=", d.chatSessionId);
  for (const t of d.threads) console.log(JSON.stringify(t));
  const canvas = await page.textContent("#chat-messages");
  console.log("canvas:", canvas.replace(/\s+/g, " ").slice(0, 160));
};

const mock = await startMockBackend();
const browser = await launchBrowser();
mock.setSessions([]);
mock.setTeam(defaultTeam({ chatWorkspaces: [WS_A] }));
mock.setEvents("s1", S1_EVENTS);
mock.setEvents("s2", S2_EVENTS);
const env = await openChat(browser, mock, {});
const { page } = env;

await wsRow(page, WS_A).click();
const t = await send(page, mock, "hello");
await reply(t, "free-reply");
await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("free-reply"));
const now = new Date().toISOString();
await applySessions(page, mock, [
  makeSession({ session_id: "s1", cwd: WS_A, agent_name: "orchestrator", first_msg: "hello", first_ts: now, last_ts: now }),
  makeSession({ session_id: "s2", cwd: WS_A, agent_name: "orchestrator", first_msg: "two" }),
]);
await dump(page, "after adopt");

// Resume s1 and send
await sessRow(page, "s1").click();
await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("free-reply"));
await dump(page, "opened s1");
let turnP = mock.nextTurn();
await page.fill("#chat-input", "ALPHA");
await page.click("#chat-send");
let turn = await turnP;
turn.send({ type: "msg_start" });
turn.send({ type: "text", delta: "ALPHA-REPLY" });
turn.send({ type: "done", sessionId: "s1" });
turn.end();
await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("ALPHA-REPLY"));
await dump(page, "sent ALPHA in s1");

// Now open s2
await sessRow(page, "s2").click();
await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("RECORDED-TWO"));
await dump(page, "opened s2");

turnP = mock.nextTurn();
await page.fill("#chat-input", "BETA");
await page.click("#chat-send");
turn = await turnP;
console.log("BETA POST body:", JSON.stringify(mock.requestsFor("/chat", "POST").at(-1).body));
turn.send({ type: "msg_start" });
turn.send({ type: "text", delta: "BETA-REPLY" });
turn.send({ type: "done", sessionId: "s2" });
turn.end();
await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("BETA-REPLY"));
await dump(page, "sent BETA in s2");

await sessRow(page, "s1").click();
await sleep(200);
await dump(page, "opened s1 again");

await wsRow(page, WS_A).click();
await sleep(200);
await dump(page, "clicked workspace");

await browser.close();
await mock.close();
