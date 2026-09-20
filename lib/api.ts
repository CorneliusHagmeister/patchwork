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

export const preflight = () =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    },
  });
