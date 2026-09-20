import { json, preflight } from "@/lib/api";
import { getState } from "@/lib/store";
import { openPulls } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// The operator's menu for starting a review round: open PRs on the repos already under audit,
// annotated with whether Patchwork has a round running for each one already.
//
// GET /api/review/open-prs            → every audited repo
// GET /api/review/open-prs?repo=snare → just that one
export async function GET(req: Request) {
  const only = new URL(req.url).searchParams.get("repo");
  const state = await getState();

  const repos = (state.repos as any[]).filter((r) => (only ? r.name === only : true));
  if (only && repos.length === 0) return json({ error: "unknown repository" }, 404);

  const targets = (state.reviewTargets as any[]) || [];

  const rows = await Promise.all(
    repos.map(async (r) => ({
      repo: r.name,
      url: r.url,
      pulls: (await openPulls(r.url || "")).map((p) => {
        const existing = targets.find((t) => t.prNumber === p.number && t.repo.endsWith("/" + (r.url || "").split("/").pop()));
        return { ...p, round: existing ? { id: existing.id, status: existing.status } : null };
      }),
    }))
  );

  return json({ repos: rows, total: rows.reduce((n, r) => n + r.pulls.length, 0) });
}
