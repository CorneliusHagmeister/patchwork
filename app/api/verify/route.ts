import { json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { addTrace, verifyFinding } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Central verifier flips the confirmed tier after re-running the PoV in a sandbox.
// Guarded by the join code for the demo; swap for a real service token in production.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  if ((b.code || "") !== (process.env.JOIN_CODE || "patchwork")) return json({ error: "forbidden" }, 403);
  // Progress line from a verify run in flight: same code guard as the verdict, so the
  // verifier streams its trace without needing a contributor token like /api/trace does.
  if (typeof b.line === "string" && !b.tier) {
    await addTrace("verifier", "tool", b.line.slice(0, 500));
    await broadcast("trace", { node: "verifier", kind: "tool", text: b.line.slice(0, 500), ts: new Date().toISOString() });
    await broadcast("state", {});
    return json({ ok: true });
  }
  const tiers = ["pending", "reproduced", "analytical", "plausible", "refuted"];
  if (!b.id || !tiers.includes(b.tier)) return json({ error: "bad request" }, 400);
  const f = await verifyFinding(b.id, b.tier, b.log);
  if (f) await broadcast("state", {});
  return f ? json(f) : json({ error: "not found" }, 404);
}
