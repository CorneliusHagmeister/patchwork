import { json, preflight } from "@/lib/api";
import { broadcast } from "@/lib/broadcast";
import { aggregateReview, markReviewPosted } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// The trusted publisher. Distributed agents never touch GitHub; the platform synthesizes ONE
// review from all their comments and posts it under a single credential (GITHUB_TOKEN). Guarded
// by the join code, mirroring /api/verify's trust model.
//
// Without GITHUB_TOKEN it runs as a dry-run: it returns the synthesized review it *would* post,
// so the whole flow is demoable offline. Body: { target, code, dry? }.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  if ((b.code || "") !== (process.env.JOIN_CODE || "patchwork")) return json({ error: "forbidden" }, 403);
  if (!b.target) return json({ error: "need {target}" }, 400);

  const agg = await aggregateReview(b.target, true);
  if (!agg) return json({ error: "unknown review target" }, 404);
  if (!agg.clusters.length) return json({ error: "no review comments to post yet" }, 400);
  // Patchwork publishes only what agents AGREE on. If nothing cleared the consensus bar this is a
  // legitimate, honest outcome (e.g. a clean PR) — not an error. Report it and don't post.
  if (!agg.agreed.length) {
    return json({ posted: false, reason: "no consensus points cleared the bar yet", stats: agg.stats });
  }

  const counts = { agreed: agg.agreed.length, solo: agg.solo.length };
  const token = process.env.GITHUB_TOKEN;
  const dry = b.dry || !token;
  if (dry) {
    return json({
      dryRun: true,
      reason: token ? "dry:true requested" : "GITHUB_TOKEN not set",
      target: agg.target,
      review: { body: agg.summaryBody, comments: agg.inlineComments },
      counts,
      stats: agg.stats,
    });
  }

  const [owner, repo] = agg.target.repo.split("/");
  const api = `https://api.github.com/repos/${owner}/${repo}/pulls/${agg.target.prNumber}/reviews`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
    "user-agent": "patchwork-swarm",
  };
  const inline = agg.inlineComments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body }));

  // First attempt: one review with all inline comments. If any line isn't part of the diff,
  // GitHub 422s the whole review — so on failure we fold the points into the body and retry
  // body-only, which always posts. Nothing is lost either way.
  const post = async (withComments: boolean) => {
    const body = withComments
      ? agg.summaryBody
      : agg.summaryBody + "\n\n" + inlineToMarkdown(agg.inlineComments);
    const payload: any = { body, event: "COMMENT" };
    if (withComments) payload.comments = inline;
    const r = await fetch(api, { method: "POST", headers, body: JSON.stringify(payload), cache: "no-store" });
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, data, text };
  };

  let res = await post(inline.length > 0);
  let mode = inline.length > 0 ? "inline" : "body-only";
  if (!res.ok && inline.length > 0) {
    // Retry without inline comments (the common cause is a line outside the diff).
    res = await post(false);
    mode = "body-only-fallback";
  }
  if (!res.ok) {
    return json({ error: "github rejected the review", status: res.status, detail: res.data?.message || res.text?.slice(0, 400) }, 502);
  }

  const postedUrl: string = res.data?.html_url || agg.target.url;
  const postedIds = agg.clusters.flatMap((c) => c.members.map((m) => m.id));
  await markReviewPosted(agg.target.id, postedUrl, postedIds);
  await broadcast("state", {});
  return json({ posted: true, mode, url: postedUrl, reviewId: res.data?.id, counts, stats: agg.stats });
}

// Fold inline comments into the review body when we can't attach them to diff lines.
function inlineToMarkdown(comments: { path: string; line: number; body: string }[]): string {
  const out = ["## Inline points", ""];
  for (const c of comments) {
    out.push(`**\`${c.path}\`:${c.line}**`, "", c.body, "");
  }
  return out.join("\n");
}
