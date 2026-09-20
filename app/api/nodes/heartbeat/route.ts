import { actor, json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { heartbeat } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  const n = await heartbeat(who.cid, who.handle, { status: b.status, currentWork: b.currentWork, location: b.location });
  await broadcast("state", {});
  return json(n);
}
