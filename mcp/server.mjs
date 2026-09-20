// Patchwork MCP server (stdio) — the Claude Desktop / MCP contribution path.
// Exposes tools to claim work, stream progress, and submit findings, plus a `hunt`
// prompt that drives the continuous claim → work → submit → claim loop.
// Configure PW_URL + (PW_TOKEN | PW_HANDLE+PW_CODE) in the MCP server env.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PW_URL = (process.env.PW_URL || "http://localhost:3040").replace(/\/$/, "");
let token = process.env.PW_TOKEN || null;

async function ensureToken() {
  if (token) return token;
  const handle = process.env.PW_HANDLE, code = process.env.PW_CODE;
  if (!handle || !code) throw new Error("Set PW_TOKEN, or PW_HANDLE + PW_CODE, in the MCP server env.");
  const r = await fetch(PW_URL + "/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle, location: process.env.PW_LOCATION || "", code }) });
  const d = await r.json();
  if (!d.ok) throw new Error("join failed: " + (d.error || r.status));
  token = d.token;
  return token;
}
async function api(path, body) {
  const t = await ensureToken();
  const r = await fetch(PW_URL + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: JSON.stringify(body || {}) });
  return r.json();
}
const txt = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "patchwork", version: "0.1.0" });

server.tool("pw_status", "Snapshot of the swarm: queued/active work, live nodes, findings so far.", {}, async () => {
  const s = await (await fetch(PW_URL + "/api/state", { cache: "no-store" })).json();
  return txt({ ...s.stats, findings: (s.findings || []).length, url: PW_URL });
});

server.tool(
  "pw_next_task",
  "Claim the next hunting work item from the server. Returns {repo,target,lens,oracle,id} or {none:true}. " +
  "After you finish a task and submit a finding, CALL THIS AGAIN to continue — keep looping until it returns none.",
  {},
  async () => {
    await api("/api/nodes/heartbeat", { status: "running" });
    const item = await api("/api/work/claim", {});
    return txt(item);
  }
);

server.tool(
  "pw_trace",
  "Post a one-line progress update to the live board. Call FREQUENTLY as you work — this is the live conversation the audience watches. kind: status|thought|tool|finding.",
  { kind: z.enum(["status", "thought", "tool", "finding"]).default("thought"), text: z.string() },
  async ({ kind, text }) => txt(await api("/api/trace", { kind, text }))
);

server.tool(
  "pw_submit_finding",
  "Submit a finding with its proof-of-vulnerability. The central verifier re-runs the PoV; set claimed='reproduced' only if it actually triggered. Attach patchDiff to allow publication (no fix, no publish).",
  {
    workItem: z.string().optional(), repo: z.string(), title: z.string(),
    oracle: z.string(), severity: z.enum(["high", "medium", "low", "info"]).default("medium"),
    claimed: z.enum(["reproduced", "analytical"]).default("analytical"),
    patch: z.boolean().default(false),
    pov: z.object({ repoUrl: z.string().optional(), repoRef: z.string().optional(), cmd: z.string().optional(), marker: z.string().optional(), notes: z.string().optional() }).optional(),
    patchDiff: z.string().optional(),
  },
  async (f) => txt(await api("/api/findings", f))
);

server.tool(
  "pw_heartbeat", "Report your node status to the board.",
  { status: z.enum(["idle", "running"]).default("running"), currentWork: z.string().optional() },
  async (b) => txt(await api("/api/nodes/heartbeat", b))
);

server.prompt("hunt", "Contribute this agent to the Patchwork swarm: loop claiming and hunting work items.", {}, () => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text:
        "You are contributing to the Patchwork OSS-security swarm. Loop:\n" +
        "1. Call pw_next_task. If it returns {none:true}, report that and stop.\n" +
        "2. Post a pw_trace saying what you claimed.\n" +
        "3. Hunt the target LOCALLY and SAFELY — never contact any live instance; sandbox everything; use the item's `oracle` to pick the right proof (crash→fuzz, resource→bounded-memory PoV, logic→differential, crypto→forge/decrypt). Post pw_trace lines as you reason.\n" +
        "4. Submit with pw_submit_finding — claimed='reproduced' ONLY with a real PoV (include pov.cmd + pov.marker so the verifier can re-run it), else 'analytical'. Attach patchDiff if you drafted a fix.\n" +
        "5. Go back to step 1 and keep going until no work remains.\n" +
        "Be honest: the central verifier re-runs your PoV and over-claims are shown publicly.",
    },
  }],
}));

await server.connect(new StdioServerTransport());
