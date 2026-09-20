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

# Integration — APPLY MANUALLY

> These edits touch files another process owns (`app/**`, the dashboard). They
> are **not** applied by this task. Copy-paste them in when ready. The two new
> helpers — `lib/broadcast.ts` and `lib/useLive.ts` — already exist and are safe.

## 1. Broadcast after mutations (server side)

In each mutating API route, import the helper and fire it **after** a successful
mutation. It's fire-and-forget and swallows all errors, so it never affects the
response. Keep it un-awaited (or `void`) so it can't add latency.

Add to the top of each route file:

```ts
import { broadcast } from "@/lib/broadcast";
```

Then, just before each successful `return json(...)`, add:

```ts
void broadcast("state", {});
```

Apply to the end of the successful path in each of:

- `app/api/repos/route.ts`
- `app/api/work/claim/route.ts`
- `app/api/findings/route.ts`
- `app/api/nodes/heartbeat/route.ts`
- `app/api/trace/route.ts`
- `app/api/verify/route.ts`

### Extra for `app/api/trace/route.ts`

The trace route feeds the live conversation stream, so also emit the trace line
itself (in addition to `"state"`). Current success path:

```ts
  await addTrace(who.handle, kind, b.text || "");
  return json({ ok: true });
```

becomes:

```ts
  await addTrace(who.handle, kind, b.text || "");
  void broadcast("trace", { node: who.handle, kind, text: b.text || "", ts: new Date().toISOString() });
  void broadcast("state", {});
  return json({ ok: true });
```

(The dashboard treats both `"state"` and `"trace"` the same — as a signal to
refetch `/api/state` — so the exact `trace` payload shape is not load-bearing;
it's there for future use / debugging.)

## 2. Dashboard: subscribe to push (client side)

`app/dashboard/page.tsx` is already a client component (`"use client"` at top),
so no directive change is needed. Add the import:

```ts
import { useLive } from "@/lib/useLive";
```

Inside `export default function Dashboard()`, the existing poll effect is:

```ts
  // poll state
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const r = await fetch("/api/state", { cache: "no-store" }); const d = await r.json(); if (alive) { setS(d); nodesRef.current = d.nodes || []; } } catch {}
    };
    tick(); const iv = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(iv); };
  }, []);
```

Replace it with a version that (a) exposes `tick` to the push handler via a ref,
and (b) lengthens the poll interval to ~5s once the relay is connected:

```ts
  const tickRef = useRef<() => void>(() => {});

  // Live push: on any push, do ONE immediate /api/state fetch (single source of truth).
  const { connected } = useLive((msg) => {
    if (msg.type === "state" || msg.type === "trace") tickRef.current();
  });

  // poll state (fallback; slows to 5s when the relay is connected)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const r = await fetch("/api/state", { cache: "no-store" }); const d = await r.json(); if (alive) { setS(d); nodesRef.current = d.nodes || []; } } catch {}
    };
    tickRef.current = tick;
    tick();
    const iv = setInterval(tick, connected ? 5000 : 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [connected]);
```

Notes:
- `connected` is in the effect deps, so when the socket connects/drops the poll
  interval automatically switches between 5000ms and 1500ms.
- `useLive` uses a ref for the latest callback internally, so passing a fresh
  arrow function each render does **not** cause reconnect churn.
- Optionally surface `connected` in the UI (e.g. a "live" dot) — not required.
