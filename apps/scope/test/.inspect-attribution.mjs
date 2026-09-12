import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("db/scope.db", { readOnly: true });

const A = "01a091ab-b55a-7552-92f2-aa24b1ec6471";
const B = "01a0923b-10cb-703f-9aad-c567173afc62";

for (const sid of [A, B]) {
  const s = db.prepare(`SELECT * FROM sessions WHERE session_id=?`).get(sid);
  console.log(`\n=== ${sid} ===`);
  console.log(`file=${s.session_file}`);
  console.log(`agent=${s.agent_name} cwd=${s.cwd} first=${s.first_ts} last=${s.last_ts} n=${s.event_count}`);
  const evs = db.prepare(`SELECT seq, ts, type, payload_json FROM events WHERE session_id=? ORDER BY seq LIMIT 12`).all(sid);
  for (const e of evs) {
    let p = "";
    try { p = JSON.stringify(JSON.parse(e.payload_json)).slice(0, 90); } catch {}
    console.log(`  ${String(e.seq).padStart(3)} ${e.ts} ${e.type.padEnd(18)} ${p}`);
  }
  console.log(`  ... total ${s.event_count}`);
}

// All sessions with their files, to see the pattern.
console.log(`\n=== all sessions ===`);
for (const s of db.prepare(`SELECT session_id, agent_name, session_file, first_ts, event_count FROM sessions ORDER BY first_ts`).all()) {
  console.log(`  ${s.first_ts}  n=${String(s.event_count).padStart(3)}  ${s.session_id}  ${s.agent_name || ""}  ${s.session_file || ""}`);
}
db.close();
