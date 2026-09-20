# Patchwork WebSocket Relay

A tiny standalone Node service that gives the Patchwork dashboard **optional
sub-second push** on top of its existing 1.5s polling. Polling stays the
always-on fallback; the relay is a pure enhancement. If the relay is down or
unconfigured, nothing breaks — the dashboard just keeps polling.

## How it works

```
 API route  --POST /emit (x-relay-secret)-->  relay (fly.io)  --ws broadcast-->  dashboard viewers
 (server)                                                                         (browser)
```

- The Next app calls `broadcast("state", {})` (server-side, fire-and-forget)
  after a successful mutation.
- The relay fans that out to every connected dashboard over WebSocket.
- On any push the dashboard does **one immediate `/api/state` fetch** — so the
  relay only signals "something changed"; `/api/state` stays the single source
  of truth (no partial-state bugs).

## Endpoints

| Method | Path       | Auth                     | Purpose                                    |
| ------ | ---------- | ------------------------ | ------------------------------------------ |
| WS     | `/`        | none                     | Dashboard viewers connect; receive JSON.   |
| POST   | `/emit`    | `x-relay-secret` header  | Broadcast `{type,data}`; 204 on success.   |
| GET    | `/health`  | none                     | Liveness → `200 "ok"`.                     |

Broadcast frames are JSON strings: `{"type":"state","data":{}}`.

## Environment

| Where       | Var                     | Example                             | Notes                                  |
| ----------- | ----------------------- | ----------------------------------- | -------------------------------------- |
| relay       | `PORT`                  | `8080`                              | Default 8080.                          |
| relay       | `RELAY_SECRET`          | `<long-random-string>`              | If unset → accepts all (dev only).     |
| Next server | `RELAY_URL`             | `https://patchwork-relay.fly.dev`   | Server-side only. Unset → broadcast no-ops. |
| Next server | `RELAY_SECRET`          | `<same-value-as-relay>`             | Must match the relay's secret.         |
| Next client | `NEXT_PUBLIC_RELAY_URL` | `wss://patchwork-relay.fly.dev`     | Unset → dashboard polling-only.        |

Generate a secret: `openssl rand -hex 32`.

## Deploy (fly.io)

From this `relay/` directory:

```bash
# 1. Create the app without deploying (fly.toml already sets app = "patchwork-relay").
flyctl launch --no-deploy

# 2. Set the shared secret (encrypted, injected at runtime).
fly secrets set RELAY_SECRET=$(openssl rand -hex 32)
#    -> copy this SAME value into the Next app's server env as RELAY_SECRET.

# 3. Deploy.
fly deploy
```

Then in the Next app's environment (e.g. Vercel project env, or `.env.local`):

```
RELAY_URL=https://patchwork-relay.fly.dev
RELAY_SECRET=<the same value you set above>
NEXT_PUBLIC_RELAY_URL=wss://patchwork-relay.fly.dev
```

Run locally: `npm install && npm start` (listens on `:8080`).

---

# Integration — DONE (wired 2026-09-20)

This is no longer a TODO. The call sites exist; this section records what was
wired and why, so the shape isn't re-litigated.

## 1. Broadcast after mutations (server side)

Each mutating route imports `broadcast` and fires it on the **successful** path only:

```ts
import { broadcast } from "@/lib/broadcast";
...
await broadcast("state", {});
```

Wired in:

| route | fires when |
|---|---|
| `app/api/join/route.ts`            | `r.ok` (a bad join code broadcasts nothing) |
| `app/api/work/claim/route.ts`      | an item was actually claimed (not on `{none:true}`) |
| `app/api/findings/route.ts`        | always (a finding was written) |
| `app/api/nodes/heartbeat/route.ts` | always — this is what drives radar liveness |
| `app/api/trace/route.ts`           | always; emits `"trace"` **and** `"state"` |
| `app/api/verify/route.ts`          | the finding existed and its tier flipped |
| `app/api/repos/route.ts`           | always (repo + work items created) |

### `await`, not `void` — deliberate

An earlier draft of this file said to keep the call un-awaited. **That is wrong on
Vercel.** A serverless function can be frozen or torn down the moment it returns
its response, so an un-awaited `fetch` may never leave the instance — which is
exactly the "relay deployed, zero frames arriving" failure this was meant to fix.
`broadcast()` is safe to await: it has a 1.5s `AbortController` timeout, swallows
every error, and no-ops entirely when `RELAY_URL` is unset. With Vercel functions
pinned to `lhr1` (`vercel.json`) and the relay in `lhr`, the real cost is a few ms.

## 2. Dashboard: subscribe to push (client side)

`app/dashboard/page.tsx` (already a client component) does:

```ts
import { useLive } from "@/lib/useLive";
...
const tickRef = useRef<() => void>(() => {});
const { connected } = useLive((msg) => {
  if (msg.type === "state" || msg.type === "trace") tickRef.current();
});

useEffect(() => {
  let alive = true;
  const tick = async () => { /* fetch /api/state, setS(d) */ };
  tickRef.current = tick;
  tick(); const iv = setInterval(tick, connected ? 5000 : 1500);
  return () => { alive = false; clearInterval(iv); };
}, [connected]);
```

Notes:
- `connected` is in the effect deps, so the poll interval switches between 5000ms
  and 1500ms automatically as the socket connects/drops.
- `useLive` keeps the latest callback in a ref, so a fresh arrow function each
  render does **not** cause reconnect churn.
- Both `"state"` and `"trace"` frames mean the same thing to the dashboard —
  refetch `/api/state`. The `trace` payload shape is not load-bearing.

## 3. Verifying it end-to-end

Attach a WS subscriber and confirm frames arrive on a real mutation:

```bash
# terminal 1 — subscribe
npx wscat -c wss://patchwork-relay.fly.dev

# terminal 2 — mutate
curl -s -XPOST https://<app>/api/join -H 'content-type: application/json' \
  -d '{"handle":"relay-test","location":"London","code":"<JOIN_CODE>"}'
```

Expect `{"type":"state","data":{}}` in terminal 1. No frame = check that
`RELAY_URL` (https, server-side) and `RELAY_SECRET` are set on the Vercel target
you actually hit, and that the secret matches fly's.

## 4. Regions

`fly.toml` pins `primary_region = "lhr"` and `vercel.json` pins
`"regions": ["lhr1"]`. Neon is `eu-west-2` and the demo audience is in London —
without both, functions run in Washington DC and every DB + relay hop crosses the
Atlantic twice. Changing either one only takes effect on a redeploy of that service.
