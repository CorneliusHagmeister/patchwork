# Patchwork — open tasks

_Current state (for continuity across compaction):_
- **Live:** https://patchwork-ebon.vercel.app (Vercel project `patchwork`, personal scope). Private GitHub repo `CorneliusHagmeister/patchwork`.
- **Neon:** wired and verified — `DATABASE_URL` in local `.env.local` (gitignored) **and** on Vercel (prod/preview/dev). State is shared + persistent (local == prod). Board = seeded demo state (4 repos, 3 confirmed, 2 over-claims).
- **Deploy is owned by session `cor-46`** (has Vercel/fly/gh auth). Division: this session builds + tests locally; `cor-46` writes Vercel env + redeploys. Don't both write the tree; `git pull --rebase` before pushing.
- **Verifier:** local Docker worker validated (`verifier/`, `npm run worker`). e2b/trigger.dev = **parked** (paid, needs Cor's explicit OK + `E2B_API_KEY`); demo plan = free local Docker worker pointed at the live URL.
- Dev server: `PORT=3040 npm run dev` (3000 is taken by a salomo checkout on this machine).

---

## TASK 1 — Distinct node per contributor (fix handle-collision) — ✅ SHIPPED (commit 7d97968)

Nodes are now keyed on a per-contributor non-secret `cid` (`rid()`, minted in `join()` and stored
on the contributor doc alongside the token). The token is NOT used as the node id — it is public
in `/api/state` and would allow impersonation.

Shipped in the working tree (not yet committed — waiting on Cor's go-ahead):
- `lib/store.ts` — `slug` exported; `join()` mints `cid` + returns it; `heartbeat(cid, handle, patch)`
  keys `nodes` by `cid`; `claimWork(cid, handle)` and `submitFinding(cid, handle, f)` thread it through.
  Findings/traces stay attributed by `handle` (display only).
- `lib/api.ts` — `actor(req)` → `{ handle, cid }`, with `c.cid || slug(c.handle)` fallback so
  pre-`cid` tokens already in Neon keep their existing node.
- `app/api/nodes/heartbeat|work/claim|findings/route.ts` — pass `who.cid, who.handle`.
- `app/dashboard/page.tsx` — unchanged (already keys off `node.id`, displays `node.handle`).

Verified locally against Neon: two `ada` joins → two `cid`s → two distinct node rows/dots
(Edinburgh + Turin, neither overwrote the other); seeded `cor`/`mira` still render; no `token`
field anywhere in `/api/state`; `npm run build` clean; `scripts/smoke.sh` passes end-to-end
(Docker verifier: positive → reproduced, bogus → refuted, over-claim caught).

**Verified in prod by `cor-46`** after redeploy: two "ada" joins → distinct cids → two distinct
node rows (Edinburgh + Turin); a hand-seeded pre-cid contributor doc (no `cid` field) still
resolves via `slug(handle)` — heartbeat 200, claim ok, no orphaning; independent token-leak walk
of `/api/state` found no `token`/`secret`/`cid` field and no live token as a value.

---

## Other open follow-ups (don't lose across compaction)

- **Zero-install Join UI (path 1).** `/api/hunt-prompt` route is built + tested (returns a
  self-contained paste-prompt with base URL + token). Still TODO: a "Copy contribute command"
  button on the Join success screen showing
  `claude -p "$(curl -s <base>/api/hunt-prompt?token=<token>)"`. Works for shell agents
  (Claude Code / Codex / Cursor) — zero install.
- **Remote HTTP MCP (Desktop / claude.ai path).** Serve the MCP (`mcp/server.mjs`) over the
  streamable-HTTP transport as a Next route so Desktop/web users "Add custom connector" by URL —
  no local install. VERIFY current claude.ai/Desktop custom-connector + auth (OAuth vs token,
  paid-plan requirement) before promising it for the demo. Desktop/web = reasoning-tier
  (analytical findings / reviews); execution stays with Claude Code + local Docker.
- **Docker prerequisite in the contributor path.** Make "have Docker running" explicit in
  `skills/hunt/SKILL.md` + `/api/hunt-prompt`, with graceful fallback to `claimed:"analytical"`
  when Docker is absent.
- **e2b / trigger.dev verifier (parked).** Only wire if Cor explicitly authorizes (paid) and
  provides `E2B_API_KEY`. Code is ready (`verifier/verify.mjs` e2b backend + `verifier/trigger/verify.ts`).
- **Review track — ✅ SHIPPED (2026-09-20).** See the TASK 3 section below.
- **fly.io relay — ✅ WIRED (2026-09-20).** See the TASK 2 section below.
- **fly.io relay — DEPLOYED but NOT WIRED (from `cor-46`, 2026-09-20).** The relay is live at
  https://patchwork-relay.fly.dev and all env is set (Vercel: `RELAY_SECRET`, `RELAY_URL` https for
  server-side, `NEXT_PUBLIC_RELAY_URL` wss for the browser — two different vars; fly: matching
  `RELAY_SECRET`). But BOTH halves are dead code: `lib/broadcast.ts`'s `broadcast()` has zero call
  sites, and `lib/useLive.ts`'s `useLive()` is never imported (the dashboard only `setInterval`s at
  1.5s). `cor-46` proved it: joined the live app with a WS subscriber attached, zero frames reached
  the relay. Fix = call `await broadcast("state", {})` after successful mutations in
  `/api/join`, `/api/work/claim`, `/api/findings`, `/api/trace`, `/api/verify`, `/api/repos`, and
  have the dashboard call `useLive()` to fire an immediate `/api/state` fetch on push (keep the 1.5s
  poll as fallback). Works the moment the calls exist. Also: both READMEs claim this is already
  wired — correct them. Also: `relay/fly.toml` pins `primary_region="iad"`; set `"lhr"` (Neon is
  eu-west-2, audience is London) or future deploys land back in the US.


---

## TASK 2 — Wire the fly.io relay — ✅ DONE (2026-09-20)

The relay was deployed but both halves were dead code. Now wired end-to-end.

- **Server push.** All seven mutating routes import `lib/broadcast.ts` and fire on the
  **successful** path only: `join` (only when `r.ok`), `work/claim` (only when an item was
  actually claimed), `findings`, `nodes/heartbeat` (this is what drives radar liveness),
  `trace` (emits `"trace"` **and** `"state"`), `verify` (only when the finding existed),
  `repos`.
- **`await`, not `void`.** `relay/README.md` previously said to keep the call un-awaited. That is
  wrong on Vercel — a function can be frozen the instant it returns, so an un-awaited `fetch` may
  never leave the instance, which is exactly the "zero frames" failure. `broadcast()` has a 1.5s
  abort timeout, swallows all errors, and no-ops without `RELAY_URL`, so awaiting is safe.
- **Client.** `app/dashboard/page.tsx` calls `useLive()`; any `state`/`trace` frame triggers one
  immediate `/api/state` fetch. `/api/state` stays the single source of truth — the relay only
  signals "something changed". Poll retained as fallback, easing 1.5s → 5s while connected.
- **Regions.** `relay/fly.toml` `iad` → `lhr`; new `vercel.json` pins `"regions": ["lhr1"]`.
  Neon is eu-west-2 and the audience is London. **Both only take effect on a redeploy of that
  service** — fly redeploy for the relay, Vercel redeploy for the app (`cor-46` owns both).
- **READMEs corrected.** Root `README.md` "Live updates" described push as already working when it
  wasn't; `relay/README.md`'s "Integration — APPLY MANUALLY" section is now a record of what was
  wired, including why `await` replaced `void`.
- `relay/package-lock.json` committed — the Dockerfile already copies `package-lock.json*`, so this
  pins `ws` for fly builds instead of floating.

**Tested locally** against a real relay on :8090 (`RELAY_SECRET` set): wrong secret → 401, right →
204. WS subscriber attached, then every route exercised — all seven produced frames, `trace`
produced `trace`+`state`, and the two negative cases produced **no** frame (bad join code; claim
returning `{none:true}`). Deterministic across repeated runs. `npm run build` clean;
`scripts/smoke.sh` green with the Docker verifier (over-claim still caught).

**Still needs `cor-46`:** fly redeploy for the `lhr` region, Vercel redeploy for `vercel.json` +
the new call sites, then the live WS-subscriber test against `wss://patchwork-relay.fly.dev`.

### ⚠️ Testing against prod Neon writes real rows
`.env.local` points at the **shared prod** Neon, so `scripts/smoke.sh` and any local API test write
rows the audience would see. Run the dev server with `DATABASE_URL=` (empty) to force the in-memory
backend — `store.ts` falls back automatically — or clean up afterwards. Seeded-board baseline is
4 repos / 8 work_items / 6 findings / nodes `cor`+`mira` / 0 contributors.

---

## TASK 3 — Review track (aggregate distributed reviews → one posted review) — ✅ SHIPPED (2026-09-20)

The hunt track finds bugs; the review track reviews a PR with a swarm and posts ONE synthesized
review. Built to sit beside the hunt track without disturbing it — new files + additive edits only.

**The story it enables:** swarm finds a bug (hunt) → an agent drafts a fix (PR #1 on the snare
fork, see below) → the swarm reviews that fix (review track) → the platform clusters everyone's
comments → operator posts one consensus review. Both tracks in one loop.

### The real PR the swarm reviews
`CorneliusHagmeister/snare#1` — "Bound the pre-auth HTTP request line and header block"
(https://github.com/CorneliusHagmeister/snare/pull/1). A hardening fix for the confirmed snare-h1
resource-consumption finding in the pre-auth HTTP path: bounds the request line, the header block
and the header count. Reproduction steps and measurements are deliberately kept out of this repo
pending upstream disclosure. 31 tests pass (4 new in `tests/limits.rs`).
Branch `patchwork/bound-http-request-line`, committed + pushed + PR open against the fork's master.

### Code (all mine; no collision with the frontend/e2b sessions)
- `lib/types.ts` — `ReviewTarget`, `ReviewComment`, `REVIEW_LENSES` (6 lenses), `ReviewCategory`,
  `Severity`; `WorkItem.reviewTarget?` added.
- `lib/aggregate.ts` (new, pure) — `aggregate(comments, target)`: clusters by
  (path, line-bucket-of-5, category) — NOT by wording, because lexical similarity misses the
  independent-agreement signal (two agents phrase the same bug differently). Consensus = number
  of DISTINCT contributors in a cluster. Ranks severity × consensus. Emits `summaryBody`
  (markdown, grouped by file), `inlineComments` (GitHub review-API shape), and per-cluster
  "other agents' notes" `<details>` blocks so no voice is lost.
- `lib/store.ts` — `addReviewTarget` (fans out one review work item per lens into `review_work`),
  `claimReview`, `submitReview`, `aggregateReview`, `markReviewPosted`; `getState()` now also
  returns `reviewTargets`, `reviewWork`, `reviewComments`. Collections: `review_targets`,
  `review_work`, `review_comments` (kept separate from hunt's `work_items`/`findings`).
- `app/api/review/{target,claim,comments,aggregate,post}/route.ts` — target-add (operator, parses
  a PR url), claim, submit-batch, aggregate (dry preview, GET+POST), and **post** (the trusted
  publisher: guarded by `JOIN_CODE` like `/api/verify`; posts ONE review via GitHub reviews API
  under `GITHUB_TOKEN`; falls back to body-only if inline lines aren't in the diff; runs as a
  dry-run returning the synthesized review when `GITHUB_TOKEN` is unset).
- `mcp/server.mjs` — `pw_review_next` + `pw_submit_review` tools and a `review` prompt for the
  Claude Desktop / MCP contribution path.

### Dashboard (the frontend session owns page.tsx; we converged on a data contract)
The redesigned dashboard consumes `s.reviewTargets` + `s.reviewComments` from `/api/state` and
fetches clusters from `/api/review/aggregate?target=<id>` (re-fetch when a comment lands). Both are
provided. Do NOT add a `rounds` field to getState — an earlier draft did; the frontend dropped it
in favour of calling the aggregate endpoint directly, so it was removed to avoid running
`aggregate()` on every poll.

### Verified
`npm run build` clean (all 5 review routes compile); `npx tsc --noEmit` clean. End-to-end smoke
(in-memory backend, `DATABASE_URL=` empty) repeatedly: 3 agents join → operator adds PR #1 →
each claims a lens → 6 comments where 2 pairs are the SAME issue found independently → aggregate
returns 6 raw → 4 distinct, consensus ×2 on both the security and correctness points, with the
minority wording preserved in a details block → dry-run post returns the review it would publish.

**Not done (needs Cor):** the REAL GitHub post. It's outward-facing, so it needs explicit go-ahead
and `GITHUB_TOKEN` in Vercel env (the chosen publisher model). The dry-run proves the synthesis;
flip `GITHUB_TOKEN` on and drop `dry` to post for real. Also open: a "review" entry point in the
zero-install hunt-prompt / Join UI so contributors can pick review vs hunt.

---

## TASK 4 — Superlinked SIE (semantic consensus) + Projects impact view — ✅ SHIPPED (2026-09-20)

Two things: an impact view, and swapping the review aggregator's clustering for embeddings.

### Projects / impact view (mine; no page.tsx collision)
- `lib/store.ts` `getProjects()` — per-repo rollup. Reconciles the two repo namings (findings store
  short "snare"; review targets store "owner/repo") on the last path segment. Emits findings tallies,
  review comments → consensus points → posted review (+ URL), distinct contributors, a `contributions`
  count (proxy for donated effort — we do NOT meter LLM time yet), and an activity ledger of concrete
  events (finding / verified / over-claim / review-comment / review-posted).
- `app/api/projects/route.ts` (GET) + `app/projects/page.tsx` — self-contained page reusing the
  frontend session's design system (shell/panel/readout/stream). Per-project panel + activity ledger,
  e.g. "@ada commented on src/httpserver.rs:341 (security)", "synthesized review posted to PR#1 ↗".

### Superlinked Inference Engine (SIE) — the orchestrator's semantic engine
SIE = superlinked/sie (open-source, checked out at ~/Documents/projects/Hackathons/open-source/sie).
OpenAI-compatible `/v1/embeddings`, port 8080 self-hosted, models Stella/Qwen3/SPLADE/etc; key is any
string self-hosted. Hackathon guide (Notion, can't scrape — needs human): the hosted endpoint + key +
model. Org gave us access.
- `lib/embeddings.ts` — `embed(texts)` → SIE `/v1/embeddings`; env `SIE_URL`, `SIE_MODEL` (default
  "stella"), `SIE_API_KEY`. Best-effort: returns null on unset/unreachable/mismatch → graceful fallback.
- `lib/aggregate.ts` — refactored: shared `finalize()`; `aggregate()` (lexical fallback) unchanged in
  behaviour; NEW `aggregateSemantic(comments, target, embeddings, model)` — union-find over same-file
  pairs with cosine ≥ `SEMANTIC_THRESHOLD` (0.8). `Aggregated.stats` now carries `method` + `model`.
- `lib/store.ts` `aggregateReview()` — embeds comment bodies via SIE when configured → semantic,
  else lexical. `app/api/projects` reports `orchestrator: {engine, model}`; `/projects` shows a
  "⚡ Powered by Superlinked" badge ONLY when engine === "superlinked-sie" (honest).

### Verified
`npm run build` clean (/projects + /api/projects in the route table); `tsc` clean. Unit test
(scratchpad sem.test.ts, tsx + mock vectors): lexical keeps two same-meaning/different-line/different-
category comments SEPARATE (consensusMax 1); semantic MERGES them (clustered 2, consensusMax 2) →
proves the quality win. Live wiring test with a mock SIE on :8099 + `SIE_URL` set: aggregate returns
method="semantic" model="stella-mock", /api/projects orchestrator="superlinked-sie". Graceful fallback
(no SIE_URL) still lexical (earlier smoke).

**Needs human:** (1) the hosted SIE endpoint URL + model + API key from the Notion guide → set SIE_URL/
SIE_MODEL/SIE_API_KEY locally + in Vercel. (2) calibrate SEMANTIC_THRESHOLD (0.8) against the real
model — paraphrases from Stella may sit ~0.6–0.85. (3) "Powered by Superlinked" on the MAIN dashboard
is the frontend session's call (I only added it to /projects). (4) LLM-time metering if you want real
"donated compute per project" rather than the contributions proxy.
