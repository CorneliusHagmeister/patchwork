import { json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { verifyFinding } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Central verifier flips the confirmed tier after re-running the PoV in a sandbox.
// Guarded by the join code for the demo; swap for a real service token in production.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  if ((b.code || "") !== (process.env.JOIN_CODE || "patchwork")) return json({ error: "forbidden" }, 403);
  const tiers = ["pending", "reproduced", "analytical", "plausible", "refuted"];
  if (!b.id || !tiers.includes(b.tier)) return json({ error: "bad request" }, 400);
  const f = await verifyFinding(b.id, b.tier, b.log);
  if (f) await broadcast("state", {});
  return f ? json(f) : json({ error: "not found" }, 404);
}
