# Patchwork — central verifier

The trust anchor. Contributors' agents are **untrusted**: they submit a finding plus a
proof-of-vulnerability (PoV). This service re-runs that PoV in an **ephemeral, isolated sandbox**
and flips the finding's confirmed `tier`. Only what reproduces here is marked `reproduced`;
a claim of `reproduced` that fails to reproduce becomes `analytical`/`refuted` — an **over-claim**,
shown publicly on the board.

```
finding (tier: pending, + pov)
   │
   ▼  clone repo @ pinned ref → drop PoV files → run cmd (network=none, mem-capped, timeout)
 sandbox ──► output/exit/crash/OOM ──► oracle-routed decision ──► LLM judge reads the trace
   │
   ▼  POST /api/verify {id, tier, log}  ──►  tier: reproduced | analytical | refuted
```

## Run it (local, now)

Runs on **your** machine — the trust boundary is your side, never a contributor's.

```bash
cd verifier
# Docker backend (rigorous): needs Docker running.
PW_URL=http://localhost:3000 PW_VERIFY_CODE=patchwork npm run worker

# No Docker? Judge-only fast path (needs ANTHROPIC_API_KEY): reads the PoV + streamed trace.
PW_SANDBOX=none ANTHROPIC_API_KEY=sk-... PW_URL=http://localhost:3000 npm run worker
```
It polls `/api/state`, verifies every `pending` finding, and flips its tier live on the board.

## Env

| var | meaning |
|---|---|
| `PW_URL` | platform base URL (default `http://localhost:3000`) |
| `PW_VERIFY_CODE` | must equal the platform's `JOIN_CODE` (guards `/api/verify`) |
| `PW_SANDBOX` | `docker` (default) · `e2b` (if `E2B_API_KEY` set) · `none` (judge/heuristic only) |
| `E2B_API_KEY` | use e2b cloud sandboxes instead of local Docker |
| `ANTHROPIC_API_KEY` | enable the LLM judge (adjudicates the trace; confirms/downgrades) |
| `PW_JUDGE_MODEL` | judge model (default `claude-sonnet-5`) |
| `PW_IMAGE` | Docker image for the sandbox (default `rust:1-slim`); a **prebuilt repo image makes flips fast** |
| `PW_POLL_MS` | poll interval (default 4000) |

## The PoV contract

A finding's `pov` (attached by the `/hunt` skill) is what gets re-run:

```jsonc
{
  "repoUrl": "https://github.com/softdevteam/snare",
  "repoRef": "6d86d72",                     // pinned commit the PoV was written against
  "files": [{ "path": "poc/run.sh", "content": "..." }],  // reproducer files dropped into the clone
  "cmd": "bash poc/run.sh",                 // runs in the repo root; sandboxed, network=none
  "marker": "PWNED-UNAUTH-EXEC",            // string printed on success (oracle-appropriate)
  "timeoutSec": 180, "memMb": 512, "notes": "differential: with-secret 401 vs no-secret 200"
}
```
Decision, routed by `oracle`: crash/panic/ASan → `memory-safety`/`panic-dos`; OOM under the mem cap →
`resource-exhaustion`; the `marker` present → `reproduced` for any class; marker specified but absent →
`refuted`; ran without a decisive signal → `analytical`. The judge then reads the trace and can confirm
`reproduced` (only when the sandbox actually ran) or downgrade.

## Cloud path (e2b + trigger.dev)

- Set `E2B_API_KEY` → sandboxes run in e2b instead of local Docker (per-finding, ephemeral).
- `trigger/verify.ts` is a trigger.dev v3 task wrapping `verifyPov`. Deploy it with the trigger.dev CLI,
  then enqueue on submission by adding to `app/api/findings/route.ts` (guard on `process.env.TRIGGER_SECRET_KEY`):
  ```ts
  const { tasks } = await import("@trigger.dev/sdk/v3");
  await tasks.trigger("verify-finding", { finding: f, url: process.env.PUBLIC_URL, code: process.env.JOIN_CODE });
  ```
  With trigger.dev wired you can retire the polling worker; without it, the worker covers everything.

## Speed for a live demo
Full Rust builds per finding are slow. Two levers: (1) **judge-only** flips in seconds off the streamed
trace; (2) **prebuilt `PW_IMAGE`** with the repo compiled so the PoV just runs. Use the judge path live,
the Docker/e2b path for rigor.

## Security
Every run is `--network=none`, memory- and time-capped, in a throwaway workdir, deleted after. Never run
the verifier with credentials the PoV could reach. The sandbox executes attacker-influenced code by design
— keep it isolated from anything that matters.
