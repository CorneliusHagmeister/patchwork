import type { ReviewComment, ReviewTarget, Severity } from "./types";

// Turn many independent agents' review comments into ONE synthesized review.
//
// The whole point of a swarm review is that agreement is signal: when three agents that never
// saw each other's work all flag the same line, that is worth more than one agent's lone opinion.
// So we cluster near-identical comments, treat the number of distinct contributors in a cluster
// as a consensus score, and rank by severity × consensus. The output is both a markdown summary
// (grouped by file) and an array of inline comments in the shape GitHub's review API wants.

export interface Cluster {
  path: string;
  line?: number;
  category: string;
  severity: Severity;        // the strongest severity anyone assigned
  consensus: number;         // how many DISTINCT contributors flagged it
  reviewers: string[];       // their handles
  body: string;              // the representative comment
  suggestion?: string;       // first suggestion offered, if any
  members: ReviewComment[];  // everything that folded into this cluster
}

export interface Aggregated {
  target: ReviewTarget;
  clusters: Cluster[];
  /** Clusters at or above MIN_CONSENSUS — the only ones that earn an inline comment. */
  agreed: Cluster[];
  /** Raised by exactly one agent. Listed for the maintainer, never posted inline. */
  solo: Cluster[];
  inlineComments: { path: string; line: number; body: string }[];
  summaryBody: string;       // the review's top-level markdown body
  stats: { raw: number; clustered: number; contributors: number; consensusMax: number; method: "lexical" | "semantic"; model?: string };
}

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };
const strongest = (a: Severity, b: Severity): Severity => (SEV_RANK[a] >= SEV_RANK[b] ? a : b);

// Comments within this many lines of each other, on the same file and category, are treated as
// the same issue. Reviewers rarely land on the exact same line for the same problem, and — more
// importantly — they word the same finding completely differently, so we cluster on WHERE and
// WHAT-KIND, not on how it's phrased. Lexical matching can't tell "unbounded read_line can OOM"
// from "read_line has no size limit" apart from unrelated text, so it would miss exactly the
// independent-agreement signal that makes a swarm review worth more than one reviewer.
const LINE_BUCKET = 5;

/** Below this many independent contributors, a point is one agent's opinion, not a finding. */
export const MIN_CONSENSUS = 2;

// Group comments that sit close together in the same file.
//
// Two deliberate choices, both of which a fixed-grid version gets wrong:
//
// 1. DISTANCE, not a grid. Rounding onto a grid (round(line/5)) splits comments that are adjacent
//    but straddle a boundary — 332 and 333 land in different buckets — while keeping comments a
//    full 5 apart together. Growing a cluster by distance from its last member makes "within
//    LINE_BUCKET lines" actually mean that. Linkage is single, so 329/333/337 chain into one
//    region; that is the intent, they are all "around line 330".
//
// 2. Category is NOT part of the key. The fan-out hands each lens to a different agent, so a
//    security-lens and a correctness-lens agent flagging the same line would never merge if
//    category were in the key — and that cross-lens agreement is exactly the independent
//    confirmation this platform exists to measure. clusterFrom() settles category by majority
//    once the members are known.
function groupByProximity(comments: ReviewComment[]): ReviewComment[][] {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) (byFile.get(c.path) || byFile.set(c.path, []).get(c.path)!).push(c);

  const out: ReviewComment[][] = [];
  for (const rows of byFile.values()) {
    // File-level comments (no line) form one cluster per file — they can't be placed.
    const fileLevel = rows.filter((r) => r.line == null);
    if (fileLevel.length) out.push(fileLevel);

    const placed = rows
      .filter((r) => r.line != null)
      .sort((a, b) => (a.line as number) - (b.line as number));

    let run: ReviewComment[] = [];
    for (const r of placed) {
      const prev = run[run.length - 1];
      if (prev && (r.line as number) - (prev.line as number) > LINE_BUCKET) {
        out.push(run);
        run = [];
      }
      run.push(r);
    }
    if (run.length) out.push(run);
  }
  return out;
}

export function aggregate(comments: ReviewComment[], target: ReviewTarget): Aggregated {
  return finalize(groupByProximity(comments).map(clusterFrom), comments, target, "lexical");
}

// Build one Cluster from a set of comments that have been decided to belong together.
function clusterFrom(members: ReviewComment[]): Cluster {
  const reviewers = [...new Set(members.map((m) => m.contributor))];
  // Representative = the longest body among the highest-severity members (most detail).
  const topSev = members.reduce<Severity>((s, m) => strongest(s, m.severity), "info");
  const rep = members.filter((m) => m.severity === topSev).sort((a, b) => b.body.length - a.body.length)[0];
  // Category = the one most members chose (semantic clustering can merge across categories).
  const catCount = new Map<string, number>();
  for (const m of members) catCount.set(m.category, (catCount.get(m.category) || 0) + 1);
  const category = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    path: rep.path, line: rep.line, category, severity: topSev,
    consensus: reviewers.length, reviewers, body: rep.body,
    suggestion: members.find((m) => m.suggestion)?.suggestion, members,
  };
}

// Rank, render, and package clusters into the final review. Shared by both clustering strategies.
function finalize(clusters: Cluster[], comments: ReviewComment[], target: ReviewTarget, method: "lexical" | "semantic", model?: string): Aggregated {
  // Rank: severity first, then consensus (independent agreement), then breadth of discussion.
  clusters.sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      b.consensus - a.consensus ||
      b.members.length - a.members.length
  );
  // The product's claim is that Patchwork publishes only what agents agree on. So agreement
  // decides what gets an inline comment; a lone voice is recorded but never posted as a finding.
  const agreed = clusters.filter((c) => c.consensus >= MIN_CONSENSUS);
  const solo = clusters.filter((c) => c.consensus < MIN_CONSENSUS);

  const inlineComments = agreed
    .filter((c) => c.line != null)
    .map((c) => ({ path: c.path, line: c.line as number, body: renderComment(c) }));
  const contributors = new Set(comments.map((c) => c.contributor)).size;
  const consensusMax = clusters.reduce((m, c) => Math.max(m, c.consensus), 0);
  return {
    target, clusters, agreed, solo, inlineComments,
    summaryBody: renderSummary(agreed, solo, target, { raw: comments.length, contributors }),
    stats: { raw: comments.length, clustered: clusters.length, contributors, consensusMax, method, model },
  };
}

/* ---------- semantic clustering (Superlinked SIE embeddings) ---------- */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Cluster on MEANING, not wording or line proximity. Two comments merge when they are in the same
// file AND their embeddings are close — so "unbounded read_line can OOM" and "no size limit →
// memory exhaustion" fuse into one consensus point even though they share almost no words and sit
// on different lines. `embeddings[i]` must correspond to `comments[i]`. Union-find over the
// same-file, above-threshold pairs. Falls back to lexical clustering if inputs don't line up.
const SEMANTIC_THRESHOLD = 0.8;
export function aggregateSemantic(comments: ReviewComment[], target: ReviewTarget, embeddings: number[][], model?: string): Aggregated {
  if (embeddings.length !== comments.length) return aggregate(comments, target);
  const parent = comments.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (let i = 0; i < comments.length; i++) {
    for (let j = i + 1; j < comments.length; j++) {
      if (comments[i].path !== comments[j].path) continue; // don't merge across files
      if (cosine(embeddings[i], embeddings[j]) >= SEMANTIC_THRESHOLD) union(i, j);
    }
  }
  const groups = new Map<number, ReviewComment[]>();
  comments.forEach((c, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)!).push(c); });
  return finalize([...groups.values()].map(clusterFrom), comments, target, "semantic", model);
}

const SEV_ICON: Record<Severity, string> = { high: "🔴", medium: "🟠", low: "🟡", info: "🔵" };

function consensusTag(c: Cluster): string {
  return c.consensus > 1 ? `**${c.consensus} reviewers** independently flagged this` : `1 reviewer`;
}

function renderComment(c: Cluster): string {
  const lines = [
    `${SEV_ICON[c.severity]} **${c.severity.toUpperCase()} · ${c.category}** — ${consensusTag(c)} (${c.reviewers.map((r) => "@" + r).join(", ")})`,
    "",
    c.body.trim(),
  ];
  // When more than one agent flagged this, show each distinct take — the point of a swarm review
  // is that the reader sees the independent observations, not just one representative.
  if (c.consensus > 1) {
    const others = dedupeBodies(c).filter((b) => b.text !== c.body.trim());
    if (others.length) {
      lines.push("", "<details><summary>Other agents' notes</summary>", "");
      for (const o of others) lines.push(`- _@${o.who}:_ ${o.text}`);
      lines.push("", "</details>");
    }
  }
  if (c.suggestion) lines.push("", "```suggestion", c.suggestion.trim(), "```");
  return lines.join("\n");
}

// One entry per contributor (their longest comment in the cluster), so the "other notes" list
// isn't padded with a single agent's repeated remarks.
function dedupeBodies(c: Cluster): { who: string; text: string }[] {
  const byWho = new Map<string, string>();
  for (const m of c.members) {
    const t = m.body.trim();
    if (!byWho.has(m.contributor) || t.length > (byWho.get(m.contributor) as string).length) byWho.set(m.contributor, t);
  }
  return [...byWho.entries()].map(([who, text]) => ({ who, text }));
}

function renderSummary(
  agreed: Cluster[],
  solo: Cluster[],
  target: ReviewTarget,
  meta: { raw: number; contributors: number }
): string {
  const clusters = agreed;
  const high = clusters.filter((c) => c.severity === "high").length;
  const med = clusters.filter((c) => c.severity === "medium").length;

  const out: string[] = [];
  out.push(`## Patchwork swarm review`);
  out.push("");
  out.push(
    `${meta.contributors} independent agents reviewed this pull request and submitted ` +
      `${meta.raw} comments. Clustering them leaves **${clusters.length + solo.length} distinct points**, ` +
      `of which **${clusters.length}** were raised independently by at least ${MIN_CONSENSUS} agents. ` +
      `Only those ${clusters.length} are commented inline below — Patchwork does not publish a single ` +
      `agent's unconfirmed opinion as a finding.`
  );
  out.push("");
  out.push(`| | count |`);
  out.push(`|---|---|`);
  out.push(`| 🔴 High | ${high} |`);
  out.push(`| 🟠 Medium | ${med} |`);
  out.push(`| Agreed points (posted) | ${clusters.length} |`);
  out.push(`| Raised once (not posted) | ${solo.length} |`);
  out.push("");

  // Group the summary by file so a reader can scan it the way they read a diff.
  const byFile = new Map<string, Cluster[]>();
  for (const c of clusters) (byFile.get(c.path) || byFile.set(c.path, []).get(c.path)!).push(c);
  for (const [path, cs] of byFile) {
    out.push(`### \`${path}\``);
    for (const c of cs) {
      const where = c.line != null ? `L${c.line}` : "file-level";
      const who = c.consensus > 1 ? ` _(×${c.consensus} agents)_` : "";
      out.push(`- ${SEV_ICON[c.severity]} **${c.category}** · ${where}${who} — ${firstSentence(c.body)}`);
    }
    out.push("");
  }
  // Recorded, not published: single-agent observations a maintainer may still want to see.
  if (solo.length) {
    out.push(`<details><summary>Also raised once, below the consensus threshold (${solo.length})</summary>`);
    out.push("");
    for (const c of solo) {
      const where = c.line != null ? `L${c.line}` : "file-level";
      out.push(`- ${SEV_ICON[c.severity]} \`${c.path}\` ${where} — ${firstSentence(c.body)} _(@${c.reviewers[0]})_`);
    }
    out.push("");
    out.push(`</details>`);
    out.push("");
  }

  out.push("---");
  out.push(
    `<sub>Posted by Patchwork. ${meta.contributors} agents reviewed independently; a point is ` +
      `published only when at least ${MIN_CONSENSUS} of them found it. Ranking = severity × agreement.</sub>`
  );
  return out.join("\n");
}

function firstSentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  const m = t.match(/^(.{0,140}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 140)).trim();
}
