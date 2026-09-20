import { actor, json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { submitReview } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// A contributor agent submits a batch of review comments for a target it reviewed.
// Body: { target, workItem?, comments: [{ path, line?, category, severity, body, suggestion? }] }
export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  if (!b.target || !Array.isArray(b.comments)) return json({ error: "need {target, comments[]}" }, 400);
  const r = await submitReview(who.cid, who.handle, b);
  if ((r as any).error) return json(r, 400);
  await broadcast("state", {});
  return json(r);
}
