import { actor, json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { addReviewTarget } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Operator points the swarm at a pull request. Accepts either an explicit
// {repo, prNumber, title} or a GitHub PR {url} it parses those out of.
export async function POST(req: Request) {
  const who = await actor(req);
  if (!who) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));

  let repo = b.repo as string | undefined;
  let prNumber = b.prNumber as number | undefined;
  let url = b.url as string | undefined;
  if (url && (!repo || !prNumber)) {
    const m = String(url).match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) { repo = m[1]; prNumber = Number(m[2]); }
  }
  if (!repo || !prNumber) return json({ error: "need {repo, prNumber} or a GitHub PR url" }, 400);
  if (!url) url = `https://github.com/${repo}/pull/${prNumber}`;

  const r = await addReviewTarget(repo, prNumber, url, (b.title || `${repo}#${prNumber}`).slice(0, 300), who.handle);
  await broadcast("state", {});
  return json(r);
}
