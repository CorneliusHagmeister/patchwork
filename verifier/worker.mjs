// Patchwork central-verifier worker — runs on YOUR side (laptop / a server), not contributors'.
// Polls the platform for findings awaiting verification, re-runs each PoV in a sandbox,
// and flips the confirmed tier. This is the trust boundary: untrusted submissions in,
// independently-reproduced verdicts out.
import { verifyPov } from "./verify.mjs";

const URL = (process.env.PW_URL || "http://localhost:3000").replace(/\/$/, "");
const CODE = process.env.PW_VERIFY_CODE || process.env.JOIN_CODE || "patchwork";
const POLL = Number(process.env.PW_POLL_MS || 4000);
const attempted = new Set();

async function loop() {
  try {
    const s = await (await fetch(URL + "/api/state", { cache: "no-store" })).json();
    const pending = (s.findings || []).filter((f) => f.tier === "pending" && !attempted.has(f.id));
    for (const f of pending) {
      attempted.add(f.id);
      console.log(`\n[verify] ${f.id} — ${f.title}`);
      const { tier, log } = await verifyPov(f, { onLog: (l) => console.log("   " + l) });
      const r = await fetch(URL + "/api/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: f.id, tier, log, code: CODE }),
      });
      console.log(`[verify] ${f.id} → ${tier} (HTTP ${r.status})`);
    }
  } catch (e) {
    console.error("worker error:", e?.message || e);
  }
  setTimeout(loop, POLL);
}

console.log(`Patchwork verifier → ${URL}  (poll ${POLL}ms, sandbox ${process.env.PW_SANDBOX || (process.env.E2B_API_KEY ? "e2b" : "docker")}, judge ${process.env.ANTHROPIC_API_KEY ? "on" : "off"})`);
loop();
