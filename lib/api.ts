import { authed, slug } from "./store";

export const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });

/** Resolve the contributor from the Authorization: Bearer <token> header. */
export async function actor(req: Request): Promise<{ handle: string; cid: string } | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const c = await authed(token);
  // cid is the public per-contributor node id. Contributors minted before cid existed
  // fall back to slug(handle) so their existing node keeps working.
  return c ? { handle: c.handle, cid: c.cid || slug(c.handle) } : null;
}

/** Public origin of this deployment: PUBLIC_URL when set, else derived from the request. */
export function baseFrom(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || new URL(req.url).host;
  const proto = h.get("x-forwarded-proto") || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export const preflight = () =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    },
  });
