import { json, preflight } from "@/lib/api";
import { getState } from "@/lib/store";
import { repoIntel } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Everything the repo page needs: what Patchwork knows (work, findings, who touched it) joined
// with what GitHub knows (stars, contributors, languages, recent commits).
//
// Findings and work items reference the repo by its SHORT name; GitHub is addressed via the
// repo's stored URL. The `intel` half is best-effort and degrades to nulls.
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const target = decodeURIComponent(name);

  const state = await getState();
  const repo = (state.repos as any[]).find((r) => r.name === target);
  if (!repo) return json({ error: "unknown repository" }, 404);

  const work = (state.work as any[]).filter((w) => w.repo === target);
  const findings = (state.findings as any[]).filter((f) => f.repo === target);
  const intel = await repoIntel(repo.url || "");

  // Who on the swarm has actually worked this repo, and how much.
  const bySwarm = new Map<string, { handle: string; work: number; findings: number }>();
  const bump = (h: string | undefined, k: "work" | "findings") => {
    if (!h) return;
    const row = bySwarm.get(h) || { handle: h, work: 0, findings: 0 };
    row[k] += 1;
    bySwarm.set(h, row);
  };
  work.forEach((w) => bump(w.claimedBy, "work"));
  findings.forEach((f) => bump(f.contributor, "findings"));

  return json({
    repo,
    intel,
    work,
    findings,
    swarm: [...bySwarm.values()].sort((a, b) => b.work + b.findings - (a.work + a.findings)),
    stats: {
      workTotal: work.length,
      workDone: work.filter((w) => w.status === "done").length,
      workActive: work.filter((w) => w.status === "running" || w.status === "claimed").length,
      reproduced: findings.filter((f) => f.tier === "reproduced").length,
      overclaims: findings.filter((f) => f.claimed === "reproduced" && (f.tier === "analytical" || f.tier === "refuted")).length,
    },
  });
}
