import { actor, json, preflight } from "@/lib/api";
import { claimWork } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const item = await claimWork(who.cid, who.handle);
  return item ? json(item) : json({ none: true });
}
