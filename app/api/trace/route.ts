import { actor, json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { addTrace } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// The live conversation stream: the /hunt skill POSTs one of these per step as it works.
export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  const kind = ["status", "thought", "tool", "finding"].includes(b.kind) ? b.kind : "thought";
  await addTrace(who.handle, kind, b.text || "");
  await broadcast("trace", { node: who.handle, kind, text: b.text || "", ts: new Date().toISOString() });
  await broadcast("state", {});
  return json({ ok: true });
}
