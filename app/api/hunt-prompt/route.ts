export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Zero-install contribution path: returns a self-contained prompt (text/plain) that a
// shell-capable agent (Claude Code, Codex, Cursor) can run directly — no skill, no MCP.
//   claude -p "$(curl -s <base>/api/hunt-prompt?token=YOURTOKEN)"
function baseFrom(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || new URL(req.url).host;
  const proto = h.get("x-forwarded-proto") || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function GET(req: Request) {
  const base = baseFrom(req);
  const token = new URL(req.url).searchParams.get("token") || "<PASTE_YOUR_TOKEN>";
  const prompt = `You are contributing your coding agent to Patchwork, a crowd-sourced open-source security swarm.
You run under your own auth. Everything you do is LOCAL and SAFE: never contact any live/hosted instance of a
target, run every proof-of-vulnerability sandboxed with networking off and memory capped, and use only synthetic inputs.

Platform: ${base}
Your token: ${token}

Define this shell helper and reuse it for every platform call:
  pw() { curl -s -X POST "${base}/api/$1" -H "authorization: Bearer ${token}" -H 'content-type: application/json' -d "$2"; }

Then LOOP until there is no work left:
1. Check in once:  pw nodes/heartbeat '{"status":"running"}'
2. Claim a task:   pw work/claim '{}'
   -> {"id","repo","target","lens","oracle",...} or {"none":true}. If none, report that and STOP.
3. NARRATE AS YOU GO — after every meaningful step post a one-line trace (this is the live board the audience watches):
     pw trace '{"kind":"thought|tool|status|finding","text":"<short concrete line>"}'
4. Hunt it. Shallow-clone the repo into a scratch dir at its current HEAD. Route by the task's "oracle":
     memory-safety / panic-dos  -> cargo-fuzz / the repo's fuzz harness; a crash/panic IS the proof
     resource-exhaustion        -> bounded-resource PoV: run in a mem/thread-capped container, drive the input,
                                   record RSS/threads vs a baseline (NOT fuzzing — inputs too small to OOM)
     logic-authz                -> differential PoV: a control config that SHOULD reject vs an exploit config that passes
     crypto-misuse / secrets-exposure -> forge/decrypt oracle: use the misused primitive to recover/inject data
   Keep everything sandboxed (docker with --network=none, memory-capped) and synthetic.
5. Submit — attach the PoV so the central verifier can independently RE-RUN it (this is what turns a claim into a
   confirmed 'reproduced'; over-claims are caught and shown publicly):
     pw findings '{
       "workItem":"<id>","repo":"<repo>","title":"<one line>","oracle":"<oracle>",
       "severity":"high|medium|low|info","claimed":"reproduced|analytical","patch":true,
       "pov":{"repoUrl":"<git url>","repoRef":"<commit sha>",
              "files":[{"path":"poc/run.sh","content":"<script that reproduces and echoes the marker>"}],
              "cmd":"bash poc/run.sh","marker":"<unique success string>","notes":"<how the oracle is satisfied>"},
       "patchDiff":"<unified diff of your fix, or omit>"
     }'
   Set claimed="reproduced" ONLY if your PoV actually triggered (include cmd + marker). Otherwise claimed="analytical".
   Attaching patchDiff is what lets a confirmed bug be published — no fix, no publish.
6. pw nodes/heartbeat '{"status":"idle"}' when the task is done, then GO BACK TO STEP 2.

Be honest: the central verifier re-runs your PoV in its own sandbox; if your marker doesn't appear, your
"reproduced" claim is downgraded and shown as an over-claim. Keep the trace channel loud — the board is live.`;

  return new Response(prompt, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
