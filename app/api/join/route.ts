import { json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { join } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const r = await join(b.handle, b.location, b.code);
  if (r.ok) await broadcast("state", {});
  return json(r, r.ok ? 200 : 400);
}
