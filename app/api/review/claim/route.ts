import { actor, json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { claimReview } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// A contributor agent claims the next queued review lens. Returns the work item plus its
// review target (repo, PR number, url, title) so the agent knows what to review, or {none:true}.
export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const item = await claimReview(who.cid, who.handle);
  if (item) await broadcast("state", {});
  return item ? json(item) : json({ none: true });
}
