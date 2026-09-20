import { json, preflight } from "@/lib/api";
import { aggregateReview, reviewQuorum } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Preview the synthesized review for a target WITHOUT posting it — the dashboard renders this
// so the operator can see exactly what would be published, plus a `quorum` block (per-lens reviews
// in, replication, postable count, ready flag) for the quorum meter. GET ?target=<id> or POST {target}.
async function run(target: string | null) {
  if (!target) return json({ error: "need ?target=<id>" }, 400);
  const agg = await aggregateReview(target, false);
  if (!agg) return json({ error: "unknown review target" }, 404);
  // Reuse the just-computed aggregate so quorum doesn't re-cluster.
  const quorum = await reviewQuorum(target, agg);
  return json({ ...agg, quorum });
}

export async function GET(req: Request) {
  return run(new URL(req.url).searchParams.get("target"));
}
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  return run(b.target || null);
}
