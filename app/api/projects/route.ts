import { json, preflight } from "@/lib/api";
import { getProjects } from "@/lib/store";
import { embeddingsEnabled, embeddingModel } from "@/lib/embeddings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Project-oriented rollup: what the donated agent time produced per repository — findings,
// review comments, the posted synthesized review, and an activity ledger of concrete events.
export async function GET() {
  const projects = await getProjects();
  const contributors = new Set<string>();
  for (const p of projects) for (const c of p.contributors) contributors.add(c);
  const totals = {
    projects: projects.length,
    contributions: projects.reduce((n, p) => n + p.contributions, 0),
    reproduced: projects.reduce((n, p) => n + p.findings.reproduced, 0),
    reviewsPosted: projects.reduce((n, p) => n + p.review.posted, 0),
    contributors: contributors.size,
  };
  // Reflects the real clustering engine so the UI can show an honest "powered by" badge.
  const orchestrator = embeddingsEnabled()
    ? { engine: "superlinked-sie", model: embeddingModel() }
    : { engine: "lexical" as const };
  return json({ projects, totals, orchestrator, serverTime: new Date().toISOString() });
}
