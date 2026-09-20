// Client hook for optional live push from the fly.io relay.
//
// If NEXT_PUBLIC_RELAY_URL is set, it opens a WebSocket, calls `onMessage` for
// every parsed {type,data} frame, auto-reconnects with capped backoff, and
// reports connection status. If unset it no-ops (returns {connected:false}) so
// the dashboard just keeps polling.
//
// No "use client" directive here — a hook file doesn't need one; it inherits
// the client context of the component that imports it (the dashboard is already
// a client component). See relay/README.md.

import { useEffect, useRef, useState } from "react";

type LiveMessage = { type: string; data: any };

export function useLive(onMessage: (msg: LiveMessage) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  // Keep the latest callback in a ref so changing it doesn't tear down the socket.
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_RELAY_URL;
    if (!url) return; // no relay configured — polling-only mode

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false; // set on unmount to stop reconnection

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      ws.onmessage = (ev) => {
        let msg: LiveMessage | null = null;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return; // ignore malformed frames
        }
        if (msg && typeof msg.type === "string") {
          try {
            cbRef.current(msg);
          } catch {
            // never let a consumer error bubble into the socket handler
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose fires next and handles the reconnect.
        try {
          ws?.close();
        } catch {}
      };
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      attempt += 1;
      // Exponential backoff, capped at 15s, with a little jitter.
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 300;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        if (ws) {
          ws.onclose = null; // prevent reconnect on intentional teardown
          ws.close();
        }
      } catch {}
      setConnected(false);
    };
  }, []);

  return { connected };
}
