import { actor, json, preflight } from "@/lib/api";
import { submitFinding } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  const f = await submitFinding(who.cid, who.handle, b);
  return json(f);
}
