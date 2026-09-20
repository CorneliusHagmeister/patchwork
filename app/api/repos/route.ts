import { actor, json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { addRepo } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// The only repos the swarm may be pointed at during the demo.
const TARGETS = ["snare", "pizauth", "who-targets-me", "vibe-kanban"];

export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  if (!b.name) return json({ error: "name required" }, 400);
  // Locked down for the live demo: contributors can queue more work against a repo
  // that is already on the board, but cannot introduce a new target. Without this any
  // holder of the join code could point the swarm at an arbitrary repository mid-talk.
  // Set ALLOW_NEW_TARGETS=1 to re-open it.
  if (process.env.ALLOW_NEW_TARGETS !== "1" && !TARGETS.includes(b.name)) {
    return json({ error: "adding new targets is disabled", allowed: TARGETS }, 403);
  }
  const targets = Array.isArray(b.targets)
    ? b.targets
    : String(b.targets || "").split(",").map((s: string) => s.trim()).filter(Boolean);
  const r = await addRepo(b.name, b.url || "", b.language || "Other", targets, who.handle);
  await broadcast("state", {});
  return json(r);
}
