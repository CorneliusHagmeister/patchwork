import { actor, json, preflight } from "@/lib/api";
import { addRepo } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  if (!b.name) return json({ error: "name required" }, 400);
  const targets = Array.isArray(b.targets)
    ? b.targets
    : String(b.targets || "").split(",").map((s: string) => s.trim()).filter(Boolean);
  const r = await addRepo(b.name, b.url || "", b.language || "Other", targets, who.handle);
  return json(r);
}
