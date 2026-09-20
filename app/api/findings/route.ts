import { actor, baseFrom, json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { submitFinding } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  const f = await submitFinding(who.cid, who.handle, b);
  await broadcast("state", {});
  // Cloud verification: hand the finding to the trigger.dev task when configured.
  // Best-effort — a verifier outage must never fail the submission, and the polling
  // worker in verifier/worker.mjs still covers anything that does not get enqueued.
  if (process.env.TRIGGER_SECRET_KEY) {
    try {
      const { tasks } = await import("@trigger.dev/sdk/v3");
      await tasks.trigger("verify-finding", {
        finding: f,
        url: baseFrom(req),
        code: process.env.JOIN_CODE || "patchwork",
      });
    } catch (e) {
      console.error("verify-finding enqueue failed", e);
    }
  }
  return json(f);
}
