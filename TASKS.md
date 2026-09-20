# Patchwork — open tasks

_Current state (for continuity across compaction):_
- **Live:** https://patchwork-ebon.vercel.app (Vercel project `patchwork`, personal scope). Private GitHub repo `CorneliusHagmeister/patchwork`.
- **Neon:** wired and verified — `DATABASE_URL` in local `.env.local` (gitignored) **and** on Vercel (prod/preview/dev). State is shared + persistent (local == prod). Board = seeded demo state (4 repos, 3 confirmed, 2 over-claims).
- **Deploy is owned by session `cor-46`** (has Vercel/fly/gh auth). Division: this session builds + tests locally; `cor-46` writes Vercel env + redeploys. Don't both write the tree; `git pull --rebase` before pushing.
- **Verifier:** local Docker worker validated (`verifier/`, `npm run worker`). e2b/trigger.dev = **parked** (paid, needs Cor's explicit OK + `E2B_API_KEY`); demo plan = free local Docker worker pointed at the live URL.
- Dev server: `PORT=3040 npm run dev` (3000 is taken by a salomo checkout on this machine).

---

## TASK 1 — Distinct node per contributor (fix handle-collision) — ✅ DONE (2026-09-20), UNCOMMITTED

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

**Next:** Cor OKs the commit → push → `cor-46` pulls + redeploys.

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
- **Review track.** Second work-item `kind: "review"`: distributed agents submit review comments →
  platform aggregates → operator posts ONE synthesized review under a single trusted credential
  (no per-contributor GitHub auth).
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
