// Patchwork WebSocket relay — minimal, standalone, production-sane.
//
// Two jobs:
//   1. Accept WebSocket viewers (the dashboard) at "/" and push JSON to them.
//   2. Accept authenticated HTTP `POST /emit` from the Next app and fan the
//      payload out to every connected viewer.
//
// It never trusts client input to do anything but stay connected, and it wraps
// every parse so one bad message can't take the process down.

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8080;
const RELAY_SECRET = process.env.RELAY_SECRET || "";
const PING_INTERVAL_MS = 30_000;

if (!RELAY_SECRET) {
  console.warn(
    "[relay] WARNING: RELAY_SECRET is not set — /emit accepts ALL requests. " +
      "This is DEV ONLY. Set RELAY_SECRET (e.g. `fly secrets set RELAY_SECRET=...`) in production."
  );
}

// --- CORS helpers ----------------------------------------------------------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-relay-secret",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...CORS, ...headers });
  res.end(body);
}

// --- Read a request body with a hard size cap ------------------------------
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// --- HTTP server -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";

    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    if (req.method === "GET" && url.startsWith("/health")) {
      send(res, 200, "ok", { "content-type": "text/plain" });
      return;
    }

    if (req.method === "POST" && url.startsWith("/emit")) {
      // Auth: constant behaviour whether the secret is set or not.
      if (RELAY_SECRET) {
        const given = req.headers["x-relay-secret"];
        if (given !== RELAY_SECRET) {
          send(res, 401, "unauthorized", { "content-type": "text/plain" });
          return;
        }
      }

      let payload;
      try {
        const raw = await readBody(req);
        payload = JSON.parse(raw || "{}");
      } catch {
        send(res, 400, "bad json", { "content-type": "text/plain" });
        return;
      }

      const type = typeof payload?.type === "string" ? payload.type : "message";
      const data = payload?.data ?? null;
      broadcast(type, data);
      send(res, 204, "");
      return;
    }

    send(res, 404, "not found", { "content-type": "text/plain" });
  } catch (err) {
    // Never crash the process on a single bad request.
    console.error("[relay] request error:", err?.message || err);
    try {
      send(res, 500, "error", { "content-type": "text/plain" });
    } catch {}
  }
});

// --- WebSocket server (shares the HTTP server) -----------------------------
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast(type, data) {
  let msg;
  try {
    msg = JSON.stringify({ type, data });
  } catch (err) {
    console.error("[relay] failed to serialize broadcast:", err?.message || err);
    return;
  }
  for (const ws of clients) {
    // 1 === WebSocket.OPEN
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch (err) {
        console.error("[relay] send failed, dropping client:", err?.message || err);
        clients.delete(ws);
        try {
          ws.terminate();
        } catch {}
      }
    }
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  clients.add(ws);

  // Viewers only receive; ignore anything they send, but never crash on it.
  ws.on("message", () => {});
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("close", () => {
    clients.delete(ws);
  });
  ws.on("error", () => {
    clients.delete(ws);
    try {
      ws.terminate();
    } catch {}
  });
});

// Keep-alive: ping every interval, drop anything that missed the last pong.
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      clients.delete(ws);
      try {
        ws.terminate();
      } catch {}
    }
  }
}, PING_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

// Last-resort guards so a stray error never kills the relay.
process.on("uncaughtException", (err) => {
  console.error("[relay] uncaughtException:", err?.message || err);
});
process.on("unhandledRejection", (err) => {
  console.error("[relay] unhandledRejection:", err?.message || err);
});

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT} (ws + http). secret ${RELAY_SECRET ? "set" : "UNSET (dev)"}.`);
});
