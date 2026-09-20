export type Tier = "pending" | "reproduced" | "analytical" | "plausible" | "refuted";
export type WorkStatus = "queued" | "claimed" | "running" | "done";

export interface Repo {
  name: string; url: string; language: string; targets: string[];
  addedBy: string; addedAt: string; status: string;
}
export interface WorkItem {
  id: string; repo: string; target: string; lens: string; oracle: string;
  status: WorkStatus; claimedBy?: string; claimedAt?: string; findingId?: string; updatedAt: string;
  reviewTarget?: string;   // set on review-track work items; ties them to a ReviewTarget
}
export interface Pov {
  repoUrl?: string;              // where to clone from
  repoRef?: string;             // pinned commit/branch the PoV was written against
  files?: { path: string; content: string }[]; // reproducer files dropped into the clone
  cmd?: string;                 // shell command run in the repo root that reproduces
  marker?: string;              // string expected in output on success (oracle-appropriate)
  timeoutSec?: number;          // hard cap (default 180)
  memMb?: number;               // memory cap for the sandbox (default 512)
  notes?: string;               // free-text the judge can read
}
export interface Finding {
  id: string; repo: string; workItem?: string; title: string; oracle: string;
  severity: "high" | "medium" | "low" | "info";
  claimed: Tier;   // what the contributor's agent asserted
  tier: Tier;      // what the central verifier confirmed
  patch: boolean; contributor: string; createdAt: string;
  pov?: Pov;       // the reproducer the central verifier re-runs
  patchDiff?: string; // proposed fix
  verifyLog?: string; // what the verifier observed
}
export interface Node {
  id: string; handle: string; location: string; status: "idle" | "running";
  currentWork?: string; workDone: number; findingsCount: number; lastSeen: string;
}
export interface Trace { id: string; node: string; kind: "status" | "thought" | "tool" | "finding"; text: string; ts: string; }

export const LENSES: { lens: string; oracle: string }[] = [
  { lens: "sink-first", oracle: "logic-authz" },
  { lens: "cwe-similarity", oracle: "memory-safety" },
  { lens: "taint-pair", oracle: "logic-authz" },
  { lens: "recency-diff", oracle: "resource-exhaustion" },
  { lens: "fuzz-lane", oracle: "panic-dos" },
];

/* ---------- review track ---------- */
// The hunt track fans out over (repo × target × oracle); the review track fans out over
// (pull-request × lens). Each contributor agent reviews the PR through one lens and submits
// review comments; the platform clusters them and an operator posts ONE synthesized review.
export type ReviewCategory = "correctness" | "security" | "performance" | "api-design" | "tests" | "docs" | "style";
export type Severity = "high" | "medium" | "low" | "info";

export const REVIEW_LENSES: { lens: string; category: ReviewCategory; brief: string }[] = [
  { lens: "correctness", category: "correctness", brief: "logic errors, edge cases, off-by-one, error handling" },
  { lens: "security", category: "security", brief: "auth, injection, resource limits, untrusted input" },
  { lens: "performance", category: "performance", brief: "allocations, complexity, hot paths, needless work" },
  { lens: "api-surface", category: "api-design", brief: "naming, signatures, backwards-compat, ergonomics" },
  { lens: "test-coverage", category: "tests", brief: "missing cases, brittle assertions, untested branches" },
  { lens: "docs-comments", category: "docs", brief: "stale/missing docs, misleading comments" },
];

// A pull request the swarm reviews. The operator adds it; the platform fans out one review
// work item per lens.
export interface ReviewTarget {
  id: string;              // slug, e.g. "snare-1"
  repo: string;            // owner/repo, e.g. "CorneliusHagmeister/snare"
  prNumber: number;
  url: string;             // https://github.com/owner/repo/pull/N
  title: string;
  status: "open" | "aggregated" | "posted";
  addedBy: string; addedAt: string;
  postedUrl?: string;      // the posted review's html_url once published
  postedAt?: string;
}

// One review comment from one agent. `dedupeKey` groups near-identical comments during
// aggregation; `posted` marks the ones that made it into the published review.
export interface ReviewComment {
  id: string; target: string; workItem?: string;
  path: string; line?: number;
  category: ReviewCategory; severity: Severity;
  body: string; suggestion?: string;   // optional ```suggestion block
  lens: string; contributor: string; createdAt: string;
  posted?: boolean;
}

/* ---------- project-oriented impact view ---------- */
// A single concrete thing the swarm produced for a project, for the activity ledger.
export interface ProjectEvent {
  ts: string;
  kind: "finding" | "verified" | "over-claim" | "review-comment" | "review-posted" | "fix";
  text: string;
  who?: string;        // contributor handle(s)
  url?: string;        // link to the artifact (posted review, PR)
  severity?: Severity;
}

// Everything the donated agent time contributed to one repository, rolled up.
export interface Project {
  key: string;         // normalized short repo name (findings + review targets reconcile on this)
  name: string;        // display name
  url?: string;
  language?: string;
  contributors: string[];
  findings: { total: number; reproduced: number; analytical: number; refuted: number; overclaims: number; patches: number };
  review: { comments: number; consensusPoints: number; posted: number; postedUrl?: string; prNumber?: number };
  contributions: number;   // concrete acts: findings + review comments (proxy for donated effort)
  lastActivity: string;
  events: ProjectEvent[];  // newest first
}
