import { actor, json, preflight } from "@/lib/api";
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
  return json({ ok: true });
}
